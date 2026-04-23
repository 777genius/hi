export type ConversationFeedAttachment = {
  id: string;
  kind: 'image';
  mime: string;
  dataUrl: string;
};

export type ConversationFeedMessage = {
  id: string;
  kind: 'stt' | 'mic' | 'haiku' | 'prompt';
  role: 'incoming' | 'outgoing';
  status: 'final' | 'streaming' | 'error';
  text: string;
  createdAtMs: number;
  seq: number;
  insertAfterId?: string;
  deleted?: boolean;
  sttIndex?: number;
  attachments?: ConversationFeedAttachment[];
};
