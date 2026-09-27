import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Both owned anchors and previously recorded Toolkit anchors use this data. */
export interface AnchorState {
  name: string;
  targetId: string;
  summary: string;
}

export interface AnchorRecord {
  id: string;
  data: AnchorState;
  onBranch: boolean;
  timestamp: string;
}

export interface AnchorQuery {
  keyword?: string;
  limit?: number;
  offset?: number;
}

export interface AnchorPage {
  anchors: AnchorRecord[];
  total: number;
  nextOffset: number | null;
}

export interface AnchorRecallHit extends AnchorRecord {
  sessionId: string;
  sessionFile: string;
  cwd: string;
}

export interface AnchorRecallPage {
  anchors: AnchorRecallHit[];
  total: number;
  nextOffset: number | null;
}

export interface AnchorRecallQuery extends AnchorQuery {
  scope?: "cwd" | "all";
  signal?: AbortSignal;
}

export type NavigationSession = ExtensionContext["sessionManager"];

/** Human UI operations. Agent pivots use a separate, origin-checked queue. */
export interface NavigationPanelActions {
  availability(): {
    enabled: boolean;
    recall: boolean;
    pivot: boolean;
    guidance: boolean;
    mutationBlocked?: string;
  };
  list(query?: AnchorQuery): AnchorPage;
  recall(query?: AnchorRecallQuery): Promise<AnchorRecallPage>;
  create(name: string, summary: string): Promise<{ ok: boolean; message: string }>;
  pivot(target: string, carryover: string, message?: string): Promise<{ ok: boolean; message: string }>;
  guide(): Promise<string>;
}
