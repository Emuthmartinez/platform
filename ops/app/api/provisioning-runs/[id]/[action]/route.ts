import { forward, platformFetch } from "../../../_shared/upstream";

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string; action: string }> },
) {
  const { id, action } = await context.params;
  if (!/^[0-9a-f-]{36}$/i.test(id) || !["approve", "apply"].includes(action)) {
    return Response.json({ error: "Invalid operation." }, { status: 400 });
  }
  return forward(await platformFetch(`/provisioning-runs/${id}/${action}`, { method: "POST" }));
}
