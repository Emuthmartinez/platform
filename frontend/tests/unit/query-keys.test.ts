import { describe, it, expect } from "vitest";
import { qk } from "@/lib/query-keys";
import {
  COLOMBIA_INCIDENT_ID,
  COLOMBIA_ORGANIZATION_ID,
  TENANT_CACHE_EPOCH,
} from "@/lib/tenant";

const tenant = [
  COLOMBIA_ORGANIZATION_ID,
  COLOMBIA_INCIDENT_ID,
  TENANT_CACHE_EPOCH,
] as const;

describe("qk (queryKeys)", () => {
  it("expone claves de prefijo estables con identidad de incidente", () => {
    expect(qk.reports.all).toEqual([...tenant, "reports"]);
    expect(qk.missing.stats).toEqual([...tenant, "missing", "stats"]);
    expect(qk.hospitals.all).toEqual([...tenant, "hospitals"]);
    expect(qk.needs.all).toEqual([...tenant, "needs"]);
  });

  it("needs.publication separa el seguimiento por job", () => {
    expect(qk.needs.publication("need-demo-1")).toEqual([
      ...tenant,
      "needs",
      "publication",
      "need-demo-1",
    ]);
  });

  it("missing.list incrusta los params y es igual para inputs iguales", () => {
    const a = qk.missing.list({ status: "active", page: 1, pageSize: 20 });
    const b = qk.missing.list({ status: "active", page: 1, pageSize: 20 });
    expect(a).toEqual(b);
    expect(a).toEqual([
      ...tenant,
      "missing",
      "list",
      { status: "active", page: 1, pageSize: 20 },
    ]);
  });

  it("hospitals.patients/supplies se parametrizan por id", () => {
    expect(qk.hospitals.patients("DEMO-hosp-3")).toEqual([
      ...tenant,
      "hospitals",
      "DEMO-hosp-3",
      "patients",
    ]);
    expect(qk.hospitals.supplies("DEMO-hosp-3")).toEqual([
      ...tenant,
      "hospitals",
      "DEMO-hosp-3",
      "supplies",
    ]);
  });

  it("missing.map admite null (sin bounds)", () => {
    expect(qk.missing.map(null)).toEqual([...tenant, "missing", "map", null]);
  });

  it("pets vive bajo su propio dominio, disjunto del de missing", () => {
    expect(qk.pets.all).toEqual([...tenant, "pets"]);
    expect(qk.pets.stats).toEqual([...tenant, "pets", "stats"]);
    expect(qk.pets.map(null)).toEqual([...tenant, "pets", "map", null]);
    expect(qk.pets.all).not.toEqual(qk.missing.all);
  });

  it("pets.list incrusta los params (incluida la especie) y es estable", () => {
    const params = {
      status: "active" as const,
      page: 1,
      pageSize: 8,
      species: "perro",
    };
    expect(qk.pets.list(params)).toEqual(qk.pets.list({ ...params }));
    expect(qk.pets.list(params)).toEqual([...tenant, "pets", "list", params]);
  });

  it("earthquakes queda en el catálogo global (KTD10), sin tenant", () => {
    expect(qk.earthquakes.all).toEqual(["g", "earthquakes"]);
    expect(qk.earthquakes.list).toEqual(["g", "earthquakes", "list"]);
    expect(qk.earthquakes.all[0]).not.toBe(COLOMBIA_ORGANIZATION_ID);
  });
});
