# Kubernetes 部署

一套可直接 `kubectl apply -k` 的最小部署：应用 + 内置 Redis（会话缓存）+ Upstash REST 桥。

```
Ingress(nginx) ──▶ Service mcp ──▶ Deployment mcp (2…8 副本)
                                        │  UPSTASH_REDIS_REST_URL
                                        ▼
                          Service redis-http (serverless-redis-http)
                                        │  Redis 协议
                                        ▼
                          StatefulSet redis (1 副本, PVC 1Gi)
```

为什么要有 `redis-http`：应用用的是 `@upstash/redis`（HTTP REST），不是 Redis 协议。`serverless-redis-http` 把 REST 翻译成 Redis 命令，所以集群内不需要 Upstash 账号，代码也不用改。

## 前置条件

| 组件 | 说明 |
|---|---|
| nginx ingress controller | Ingress 用了 `nginx.ingress.kubernetes.io/*` 注解（SSE 需要关 buffering） |
| cert-manager | 可选；不用的话删掉 `tls` 段和 `cert-manager.io/cluster-issuer` 注解 |
| StorageClass | Redis 的 PVC 需要默认 StorageClass（或给它加 `storageClassName`） |
| metrics-server | HPA 需要 |

## 部署

```bash
# 1) 命名空间 + 密钥（不要提交真实值）
kubectl create namespace shanghaitech-mcp

REDIS_PASS="$(openssl rand -hex 24)"
kubectl -n shanghaitech-mcp create secret generic mcp-secrets \
  --from-literal=MCP_ENC_KEY="$(openssl rand -base64 32)" \
  --from-literal=MCP_AUTH_TOKEN="$(openssl rand -hex 32)" \
  --from-literal=REDIS_PASSWORD="$REDIS_PASS" \
  --from-literal=REDIS_REST_TOKEN="$(openssl rand -hex 24)" \
  --from-literal=REDIS_CONNECTION_STRING="redis://:${REDIS_PASS}@redis:6379"

# 2) 改域名（overlays/example 里是 mcp.example.com）
kubectl kustomize deploy/k8s/overlays/example > /tmp/mcp.yaml   # 先看渲染结果
kubectl apply -k deploy/k8s/overlays/example
```

只想要 base（域名仍是 `mcp.example.com`）：`kubectl apply -k deploy/k8s/base`。

## 验证

```bash
kubectl -n shanghaitech-mcp rollout status deploy/mcp
kubectl -n shanghaitech-mcp port-forward svc/mcp 8080:80 &
curl -s -X POST http://127.0.0.1:8080/api/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | head -c 200
```

首次连接客户端时，把 `Authorization: Bearer $MCP_AUTH_TOKEN` 放进 MCP 客户端配置。

## 配置与密钥

| 变量 | 来源 | 说明 |
|---|---|---|
| `MCP_ENC_KEY` | Secret | 32 字节 base64，密封 session 句柄；**轮换 = 所有人需重新 ids_login** |
| `MCP_AUTH_TOKEN` | Secret，可选 | MCP 端点的静态 bearer；不设则对集群内网开放 |
| `REDIS_PASSWORD` / `REDIS_CONNECTION_STRING` | Secret | Redis 自身鉴权与桥的连接串 |
| `REDIS_REST_TOKEN` | Secret | 桥的 token，同时作为应用的 `UPSTASH_REDIS_REST_TOKEN` |
| 平台地址 | ConfigMap | `IDS_BASE_URL`、`ELRC_BASE_URL`、`WIKI_BASE_URL`、`PRINT_BASE_URL` … |

非密配置在 `base/configmap.yaml`，用 kustomize patch 覆盖即可。

## 已知注意点

1. **Redis 是缓存不是数据库**：`appendonly no` + 单副本。Redis 重启后所有 session 失效，用户重新 `ids_login` 即可；如果希望重启不丢，把 `--appendonly` 改成 `yes`。
2. **文印系统在校内网**（`10.15.21.225`）：只有出口在校园网、或能路由到该网段的集群才能用 `print_*` 工具，否则会超时。其余平台公网可达。
3. **会话 TTL**：ticket 12h、派生会话 30min，由应用自己续签，和副本数无关（状态都在 Redis）。
4. **SSE/长请求**：Ingress 已设 `proxy-buffering: off` 与 300s 超时；工具调用最慢的是 EAMS/ELRC 抓取，别把 ingress 超时调到 60s 以下。
5. **镜像可见性**：`ghcr.io/shanghaitechgeekpie/shanghaitech-mcp` 现在是 public 包，不需要 `imagePullSecret`。如果哪天组织策略要求改回 private，再建 secret 并挂回 `imagePullSecrets`：
   ```bash
   kubectl -n shanghaitech-mcp create secret docker-registry ghcr \
     --docker-server=ghcr.io --docker-username=<user> --docker-password=<只勾 read:packages 的 PAT>
   kubectl -n shanghaitech-mcp patch deploy/mcp \
     -p '{"spec":{"template":{"spec":{"imagePullSecrets":[{"name":"ghcr"}]}}}}'
   ```
6. **只读根文件系统**：容器以 uid 1001、`readOnlyRootFilesystem: true` 运行，只为 `/app/.next/cache` 和 `/tmp` 挂了 emptyDir；如果以后引入需要写盘的功能，记得补挂载。

7. **校园网出口走 acm 的 SNI 反代**：`*.shanghaitech.edu.cn` 只接受校园网来源的连接，本集群的出口（119.78.253.23）不在允许范围，直接解析公网 IP 只会 `ETIMEDOUT`。现方案复用 acm 机器（`acm.shanghaitech.edu.cn`，入口 `119.78.254.196`）的 nginx `stream` 按 SNI 转发：

   ```nginx
   upstream c_ids { server 10.15.44.192:443; }          # ids / egate
   upstream c_ecourse { server 10.15.145.187:443; }
   upstream c_eams { server 10.15.44.85:443; }
   upstream c_elearning { server 10.15.45.24:443; }
   upstream c_elrc { server 10.15.145.44:443; }
   upstream c_libspace { server 10.15.145.161:443; }

   map $ssl_preread_server_name $backend_name {
       ids.shanghaitech.edu.cn        c_ids;
       egate.shanghaitech.edu.cn      c_ids;
       ecourse.shanghaitech.edu.cn    c_ecourse;
       eams.shanghaitech.edu.cn       c_eams;
       elearning.shanghaitech.edu.cn  c_elearning;
       elrc.shanghaitech.edu.cn       c_elrc;
       libspace.shanghaitech.edu.cn   c_libspace;
       ...原有条目...
   }
   ```

   配合 Deployment 的 `hostAliases`（`deploy/k8s/base/app.yaml`）把这几个域名钉到 `119.78.254.196`。TLS 是透传的，证书/SNI/Host/Cookie 域全部保持原样，应用代码不需要任何代理配置。

   注意：**上游 IP 是硬编码的**，校园内 DNS 变了要同步改 acm 的 nginx；`10.15.21.225`（文印，纯 HTTP、无 SNI）无法走这条链路，`print_*` 仍需别的通道。集群自身能拉镜像/访问公网，只是到不了校园内网，所以别把这条当成通用出站代理。

## 换用托管 Upstash

不想在集群里跑 Redis：删掉 `redis.yaml`、`redis-http.yaml`，把 ConfigMap 的 `UPSTASH_REDIS_REST_URL` 改成 Upstash 的 URL，Secret 里的 `REDIS_REST_TOKEN` 换成 Upstash token 即可，应用侧无改动。
