/** Public Web game API v1. Never return a private rule object through Remote. */
export type DuelActor = "human" | "agent";
export type AgentSeat = "agent" | "agent2";
export type Actor = DuelActor | "agent2";
export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };
export type Action = { kind: string; [key: string]: Json };
export interface Observation {
  matchId: string;
  revision: number;
  phase: string;
  outcome: string;
  actions: Action[];
  [key: string]: Json;
}
export interface GameMatch {
  observe(viewer: Actor): Observation;
  apply(actor: Actor, expectedRevision: number, action: Action): string;
  nextHand(): string;
}
export interface GameMetadata {
  apiVersion: 1;
  id: string;
  name: string;
  version: string;
  rulesVersion: string;
  rules: string;
  /** Defaults to one. Additional seats are independently scoped DSH sessions. */
  agentSeats?: 1 | 2;
}
export interface GameDefinition extends GameMetadata {
  create(matchId: string): GameMatch;
  /** Optional compact model view. Receives only the existing Agent perspective. */
  projectAgentContext?(observation: Observation): {
    observation: Observation;
    summary?: Json;
  };
}
export type AgentGameMetadata = Omit<GameMetadata, "rules">;
export interface AgentMatchMemory {
  game: AgentGameMetadata;
  matchId: string;
  timestamp: string;
  outcome: string;
  summary?: Json;
}
export interface AgentMemory {
  chat: ChatMessage[];
  results: AgentMatchMemory[];
  companion?: CompanionTurn[];
}
export interface CompanionRef {
  entry: string;
  petId: string;
}
export interface CompanionDisplay extends CompanionRef {
  key: string;
  name: string;
  kind: "dsh_pet";
}
export interface CompanionTurn {
  role: "user" | "assistant";
  content: string;
  ts: number;
}
export interface CompanionPreview {
  display: CompanionDisplay;
  persona: string;
  turns: CompanionTurn[];
  configuredRounds: number;
  loadedRounds: number;
  omitted: boolean;
  personaBytes: number;
  memoryBytes: number;
}
export interface PublicReport {
  id: string;
  matchId: string;
  gameId: string;
  gameName: string;
  companion: CompanionDisplay;
  text: string;
  createdAt: string;
}
export interface ReportJob extends PublicReport {
  status: "queued" | "sending" | "written" | "failed" | "unknown";
  error: string;
  reply?: string;
}
export interface AgentWakePayload {
  seat?: AgentSeat;
  game: AgentGameMetadata | null;
  observation: Observation | null;
  paused: boolean;
  humanChat: ChatMessage[];
  chatSequence: number;
  memory: AgentMemory;
}
export interface ModelChoice {
  provider: string;
  model: string;
  reasoningEffort?: string;
}
export interface ChatMessage {
  sequence: number;
  sender: Actor;
  timestamp: string;
  kind: "text" | "emoji";
  content: string;
  gameId: string | null;
  matchId: string | null;
  companionKey?: string;
  senderName?: string;
  origin?: "pet_report";
}
export interface DisplayPreferences {
  fontPercent: 100 | 125;
  reduceMotion: boolean;
}
export interface PlatformSnapshot {
  instanceId: string;
  cursor: number;
  games: GameMetadata[];
  game: GameMetadata | null;
  observation: Observation | null;
  sessionId: string | null;
  model: ModelChoice | null;
  agentStatus: "unconfigured" | "idle" | "running" | "paused" | "error";
  error: string;
  opponents?: OpponentSnapshot[];
  messages: ChatMessage[];
  chatSequence: number;
  humanReadSequence: number;
  unread: number;
  truncated: boolean;
  preferences: DisplayPreferences;
  companion?: CompanionDisplay | null;
  opponent?: CompanionDisplay | null;
  report?: PublicReport | null;
  reportJobs?: ReportJob[];
  reportError?: string;
  companionFeedback?: {
    state: "idle" | "pending" | "sent" | "error";
    message: string;
    animation?: string | null;
  };
  companionFocus?: {
    state: "idle" | "starting" | "focused" | "interrupted" | "error";
    message: string;
  };
}
export interface OpponentSnapshot {
  seat: AgentSeat;
  name: string;
  sessionId: string | null;
  model: ModelChoice | null;
  status: PlatformSnapshot["agentStatus"];
  error: string;
}
export interface Receipt {
  accepted: boolean;
  error: string;
  observation?: Observation | null;
  sequence?: number;
}
export interface OpponentDriver {
  sessionId: string;
  wake(input: string): Promise<void>;
  selectModel(model: ModelChoice): Promise<void>;
  cancel(): Promise<void>;
  dispose(): Promise<void>;
}
export interface GameViewProps {
  observation: Observation;
  busy: boolean;
  reduceMotion: boolean;
  opponentName?: string;
  opponentNames?: Partial<Record<AgentSeat, string>>;
  act(action: Action): Promise<void>;
  next(): Promise<void>;
  rematch(): Promise<void>;
  leave(): Promise<void>;
}
export interface GameViewRegistration {
  id: string;
  version: string;
  component: import("react").ComponentType<GameViewProps>;
  historyComponent?: import("react").ComponentType<GameHistoryProps>;
}
export interface GameHistoryProps {
  observation: Observation;
  close(): void;
  opponentName?: string;
  opponentNames?: Partial<Record<AgentSeat, string>>;
}
export interface GameViewRegistry {
  register(view: GameViewRegistration): () => void;
}
export interface GameRegistry {
  registerGame(definition: GameDefinition): () => void;
}
export const EMOJI = [
  "😀",
  "😂",
  "😅",
  "😎",
  "🤔",
  "😮",
  "😢",
  "👍",
  "👏",
  "🙌",
  "🎉",
  "❤️",
] as const;
export const EMOJI_NAMES = [
  "开心",
  "大笑",
  "汗颜",
  "酷",
  "思考",
  "惊讶",
  "难过",
  "赞",
  "鼓掌",
  "欢呼",
  "庆祝",
  "爱心",
];
export const clone = <T>(value: T): T => structuredClone(value);
