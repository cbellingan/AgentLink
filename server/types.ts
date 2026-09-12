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

export interface LinkRecord {
  id: string;
  agentAId: string;
  agentBId: string;
  initiatorHumanId: string;
  responderHumanId?: string;
  status: 'pending_approval' | 'active' | 'revoked';
  createdAt: string;
  linkKey?: string;
  approvals: Record<string, boolean>;
  bytesAtoB?: number;
  bytesBtoA?: number;
  framesCount?: number;
  recentMessages?: Array<LinkMessageEntry>;
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

