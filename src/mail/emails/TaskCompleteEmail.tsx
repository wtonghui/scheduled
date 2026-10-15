import {
  Body,
  Container,
  Head,
  Heading,
  Html,
  Preview,
  Section,
  Text,
} from "@react-email/components";

/**
 * 任务终态通知邮件（react-email，HTML 与纯文本双版本由 render 生成）。
 */

export interface TaskCompleteEmailProps {
  taskName: string;
  status: "succeeded" | "failed" | "dead";
  taskId: string;
  runId: string;
  scheduledAt: string;
  durationMs?: number | null;
  errorMessage?: string | null;
  appBaseUrl: string;
}

export function TaskCompleteEmail(props: TaskCompleteEmailProps) {
  // 默认正文只留运行五项；errorMessage/appBaseUrl 保留在接口上（调用方不动），正文不再渲染
  const { taskName, status, taskId, runId, scheduledAt, durationMs } = props;
  const ok = status === "succeeded";
  const icon = ok ? "✅" : "❌";

  return (
    <Html>
      <Head />
      <Preview>
        {icon} [{taskName}] 执行{ok ? "成功" : "失败"}
      </Preview>
      <Body style={{ fontFamily: "system-ui, sans-serif", color: "#1a1a1a", padding: "24px" }}>
        <Container
          style={{
            border: "1px solid #e3e3e3",
            borderRadius: 8,
            padding: "24px",
            maxWidth: 560,
          }}
        >
          <Heading style={{ marginTop: 0, marginBottom: 12, fontSize: 20 }}>
            {icon} {taskName} — 执行{ok ? "成功" : "失败"}
          </Heading>
          <Section style={{ fontSize: 14, lineHeight: 1.7 }}>
            <Text style={{ margin: "0 0 16px" }}>
              <span
                style={{
                  display: "inline-block",
                  backgroundColor: ok ? "#16a34a" : "#dc2626",
                  color: "#ffffff",
                  borderRadius: 999,
                  padding: "2px 12px",
                  fontSize: 13,
                }}
              >
                {ok ? "成功" : "失败"}
              </span>
            </Text>
            <Text style={{ margin: "8px 0" }}>
              <strong>Run</strong>: <code>{runId}</code>
            </Text>
            <Text style={{ margin: "8px 0" }}>
              <strong>Status</strong>: {status}
            </Text>
            <Text style={{ margin: "8px 0" }}>
              <strong>Task</strong>: <code>{taskId}</code>
            </Text>
            <Text style={{ margin: "8px 0" }}>
              <strong>Scheduled</strong>: {scheduledAt}
            </Text>
            {durationMs != null && (
              <Text style={{ margin: "8px 0" }}>
                <strong>Duration</strong>: {durationMs}ms
              </Text>
            )}
          </Section>
        </Container>
      </Body>
    </Html>
  );
}
