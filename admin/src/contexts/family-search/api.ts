/**
 * Llamadas al BFF `/api/admin/family-search/*` — todas vía
 * `requestDecisionJson` (compartido con U5/patient-imports, ver
 * `@/src/shared/mutation/use-decision-mutation`) para que TANTO lecturas
 * como escrituras lancen `DecisionRequestError` con el status HTTP real
 * adjunto — el componente de ficha necesita distinguir un 404 (cluster no
 * encontrado) igual que match-card necesita distinguir 409/403.
 */
import {
  jsonRequestInit,
  requestDecisionJson,
} from "@/src/shared/mutation/use-decision-mutation";
import type {
  ClusterFichaResponse,
  DecisionResponse,
  LinkDecisionValue,
  ProposeResponse,
  QueueResponse,
  RecordSearchResponse,
  SignalDecisionResponse,
  SignalDecisionValue,
  SignalsQueueResponse,
  UnmergeResponse,
} from "./types";
import { scopedQueryKey } from "@/src/lib/query-scope";

const BASE = "/api/admin/family-search";

export function queueQueryKey(status?: string) {
  return scopedQueryKey("family-search-queue", status ?? "proposed");
}

export async function fetchQueuePage(params: {
  status?: string;
  before?: string | null;
  limit?: number;
}): Promise<QueueResponse> {
  const qs = new URLSearchParams();
  if (params.status) qs.set("status", params.status);
  if (params.before) qs.set("before", params.before);
  qs.set("limit", String(params.limit ?? 25));
  return requestDecisionJson<QueueResponse>(`${BASE}/queue?${qs.toString()}`);
}

export interface DecisionPayload {
  decision: LinkDecisionValue;
  note?: string;
}

export function postDecision(linkId: string, payload: DecisionPayload): Promise<DecisionResponse> {
  return requestDecisionJson<DecisionResponse>(
    `${BASE}/decision/${encodeURIComponent(linkId)}`,
    jsonRequestInit("POST", payload),
  );
}

export function postPropose(prnA: string, prnB: string): Promise<ProposeResponse> {
  return requestDecisionJson<ProposeResponse>(
    `${BASE}/propose`,
    jsonRequestInit("POST", { prnA, prnB }),
  );
}

export function postUnmerge(linkId: string, note?: string): Promise<UnmergeResponse> {
  return requestDecisionJson<UnmergeResponse>(
    `${BASE}/unmerge/${encodeURIComponent(linkId)}`,
    jsonRequestInit("POST", { note }),
  );
}

export function fetchRecordsSearch(q: string, limit = 20): Promise<RecordSearchResponse> {
  const qs = new URLSearchParams({ q, limit: String(limit) });
  return requestDecisionJson<RecordSearchResponse>(`${BASE}/records/search?${qs.toString()}`);
}

export function fetchClusterFicha(clusterId: string): Promise<ClusterFichaResponse> {
  return requestDecisionJson<ClusterFichaResponse>(
    `${BASE}/clusters/${encodeURIComponent(clusterId)}`,
  );
}

// -------------------------------------------------------- U15 (señales) ---

/** Query key BASE de la cola de señales — SIN parámetros (a diferencia de
 *  `queueQueryKey`, que varía por `status`): `record-signals.router.ts` no
 *  tiene un filtro de status en la URL, la cola siempre es "pending". Usada
 *  también por `shell.tsx` (nav badge) y `cluster-ficha.tsx` (chip de
 *  cluster) para leer/invalidar el MISMO cache — ver esos archivos. */
export function clusterFichaQueryKey(clusterId: string) {
  return scopedQueryKey("family-search-cluster", clusterId);
}

export function recordsSearchQueryKey(query: string) {
  return scopedQueryKey("family-search-records-search", query);
}

export function signalsQueryKey() {
  return scopedQueryKey("family-search-signals");
}

export async function fetchSignalsPage(params: {
  after?: string | null;
  limit?: number;
}): Promise<SignalsQueueResponse> {
  const qs = new URLSearchParams();
  if (params.after) qs.set("after", params.after);
  qs.set("limit", String(params.limit ?? 25));
  return requestDecisionJson<SignalsQueueResponse>(`${BASE}/signals?${qs.toString()}`);
}

export interface SignalDecisionPayload {
  decision: SignalDecisionValue;
  note?: string;
}

export function postSignalDecision(
  signalId: string,
  payload: SignalDecisionPayload,
): Promise<SignalDecisionResponse> {
  return requestDecisionJson<SignalDecisionResponse>(
    `${BASE}/signals/${encodeURIComponent(signalId)}/decision`,
    jsonRequestInit("POST", payload),
  );
}
