import { IDS_BASE_URL, IDS_PATHS } from "@/lib/campus/ids";

export default function Home() {
  return (
    <main>
      <h1>shanghaitech-mcp</h1>
      <p>上海科技大学校园 MCP 服务器。MCP 端点在 <code>/api/mcp</code>（Streamable HTTP）。</p>

      <h2>接入</h2>
      <pre style={{ background: "#f4f4f5", padding: "1rem", overflowX: "auto" }}>
        {`{
  "mcpServers": {
    "shanghaitech": {
      "type": "http",
      "url": "https://<deployment>/api/mcp",
      "headers": { "Authorization": "Bearer $MCP_AUTH_TOKEN" }
    }
  }
}`}
      </pre>

      <h2>已提供工具</h2>
      <ul>
        <li>
          <code>coursebench_search_courses</code> — 课程评价搜索（公开数据）
        </li>
        <li>
          <code>coursebench_course_detail</code> — 课程详情与教师分组
        </li>
        <li>
          <code>coursebench_course_comments</code> — 课程点评
        </li>
      </ul>

      <h2>身份</h2>
      <p>
        IDS 统一身份认证：<a href={`${IDS_BASE_URL}${IDS_PATHS.login}`}>{IDS_BASE_URL}</a>
        （Wisedu，CAS 协议）。按用户登录的 OAuth 2.1 桥接尚未启用。
      </p>
    </main>
  );
}
