import { forward, platformFetch } from "../../_shared/upstream";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return forward(await platformFetch(`/operators/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: await request.text(),
  }));
}
