import type { Metadata } from "next";
import { Shell } from "../shell";
import { DeploymentsAdmin } from "@/src/contexts/deployments/deployments-admin";
import { RequireCapability } from "@/src/shared/auth/admin-gate";

export const metadata: Metadata = {
  robots: { index: false },
};

export default function Page() {
  return (
    <Shell>
      <RequireCapability
        cap="deployment:manage"
        fallback={<p>No tienes permiso (deployment:manage).</p>}
      >
        <DeploymentsAdmin />
      </RequireCapability>
    </Shell>
  );
}
