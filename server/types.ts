export interface HumanUser {
  id: string;
  email: string;
  name: string;
  avatar?: string;
  role?: string;
}

export interface ApiKeyRecord {
  id: string;
  key: string;
  ownerHumanId: string;
  label?: string;
  createdAt: string;
  lastUsedAt?: string;
}

export interface KeyRotationEntry {
  timestamp: string;
  actor: string;
  previousKid?: string;
  previousSignPub?: string;
  previousEncPub?: string;
  newKid: string;
  newSignPub?: string;
  newEncPub?: string;
  authorizationType: 'human_admin' | 'previous_key_signature' | 'human_session' | 'authorized_key_rotation';
}

export interface AgentRecord {
  id: string;
  ownerHumanId: string;
  registeredAt: string;
  signPub?: string;
  encPub?: string;
  kid?: string;
  qrPayload?: string;
  connected: boolean;
  polling: boolean;
  lastSeen: string;
  peerVerification?: any;
  rotations?: KeyRotationEntry[];
}

export interface LinkMessageEntry {
  id?: string;
  timestamp: string;
  senderId: string;
  targetId?: string;
  text: string;
  isEncrypted?: boolean;
  payload?: any;
}

export interface LinkApprovalDetail {
  approved: boolean;
  confirmedAt?: string;
  confirmedKid?: string;
  confirmedSafetyNumber?: string;
}

export interface LinkMetrics {
  totalMessages: number;
  messagesAtoB: number;
  messagesBtoA: number;
  deliveredMessages: number;
  pendingMessages: number;
  failedMessages: number;
  totalBytes: number;
  bytesAtoB: number;
  bytesBtoA: number;
  avgPayloadBytes: number;
  maxPayloadBytes: number;
  reliabilityPercent: number;
  status: 'optimal' | 'pending' | 'degraded' | 'idle';
  lastActivityAt?: string;
  lastDeliveredAt?: string;
  lastSequenceA?: number;
  lastSequenceB?: number;
}

export interface LinkRecord {
  id: string;
  agentAId: string;
  agentBId: string;
  initiatorHumanId?: string;
  responderHumanId?: string;
  initiatorHumanEmail?: string;
  responderHumanEmail?: string;
  status: 'pending_approval' | 'active' | 'revoked';
  createdAt: string;
  linkKey?: string;
  approvals: Record<string, boolean | LinkApprovalDetail>;
  safetyNumber?: string;
  agentPrompt?: string;
  bytesAtoB?: number;
  bytesBtoA?: number;
  totalBytes?: number;
  maxPayloadBytes?: number;
  framesCount?: number;
  framesAtoB?: number;
  framesBtoA?: number;
  framesDelivered?: number;
  framesFailed?: number;
  lastActivityAt?: string;
  lastDeliveredAt?: string;
  lastSequenceA?: number;
  lastSequenceB?: number;
  metrics?: LinkMetrics;
  recentMessages?: Array<LinkMessageEntry>;
  note?: string;
}

export interface InviteRecord {
  id: string;
  inviterHumanId: string;
  inviterEmail: string;
  recipientEmail: string;
  fromAgentId?: string;
  targetAgentId?: string;
  linkId?: string;
  token?: string;
  safetyNumber?: string;
  agentPrompt?: string;
  status: 'pending' | 'accepted' | 'expired' | 'revoked';
  createdAt: string;
  expiresAt: string;
  note?: string;
}

export interface AccessLogEntry {
  id: string;
  timestamp: string;
  ip: string;
  method: string;
  url: string;
  statusCode: number;
  durationMs: number;
  identity: string;
  userAgent?: string;
  securityNote?: string;
}

export interface ClientLogEntry {
  id: string;
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  category: string;
  message: string;
  details?: any;
  userAgent?: string;
  ip?: string;
}

export interface BugReportRecord {
  id: string;
  agentId?: string;
  submitterHumanId?: string;
  submitterEmail?: string;
  title: string;
  details: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  context?: any;
  timestamp: string;
  ip?: string;
  userAgent?: string;
  resolved: boolean;
  resolvedAt?: string;
  resolvedBy?: string;
  resolutionNote?: string;
}


