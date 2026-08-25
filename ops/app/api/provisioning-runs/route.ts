import { forward, platformFetch } from "../_shared/upstream";

export async function GET() {
  return forward(await platformFetch("/provisioning-runs"));
}

export async function POST(request: Request) {
  return forward(
    await platformFetch("/provisioning-runs", { method: "POST", body: await request.text() }),
  );
}
