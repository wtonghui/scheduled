import {
  Body,
  Container,
  Head,
  Heading,
  Hr,
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
  const { taskName, status, taskId, runId, scheduledAt, durationMs, errorMessage, appBaseUrl } =
    props;
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
          <Heading style={{ marginTop: 0, fontSize: 20 }}>
            {icon} {taskName} — 执行{ok ? "成功" : "失败"}
          </Heading>
          <Section style={{ fontSize: 14, lineHeight: 1.7 }}>
            <Text>
              <strong>Run</strong>: <code>{runId}</code>
            </Text>
            <Text>
              <strong>Status</strong>: {status}
            </Text>
            <Text>
              <strong>Task</strong>: <code>{taskId}</code>
            </Text>
            <Text>
              <strong>Scheduled</strong>: {new Date(scheduledAt).toISOString()}
            </Text>
            {durationMs != null && (
              <Text>
                <strong>Duration</strong>: {durationMs}ms
              </Text>
            )}
            {errorMessage && (
              <Text style={{ color: "#b42318" }}>
                <strong>Error</strong>: {errorMessage}
              </Text>
            )}
          </Section>
          <Hr />
          <Text style={{ fontSize: 12, color: "#666" }}>
            <a href={`${appBaseUrl}/tasks/${taskId}`}>查看详情</a> · Scheduled Task Manager
          </Text>
        </Container>
      </Body>
    </Html>
  );
}