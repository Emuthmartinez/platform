import { forward, platformFetch } from "../_shared/upstream";

export async function GET() {
  return forward(await platformFetch("/portfolio"));
}
