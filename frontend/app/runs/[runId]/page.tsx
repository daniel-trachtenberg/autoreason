import { RunScreen } from "@/components/run-screen";

export default async function RunPage({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  const { runId } = await params;
  return <RunScreen runId={runId} />;
}
