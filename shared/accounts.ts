export type AccountView = {
  username: string;
  role: 'admin' | 'user';
  quota: number;
  used: number;
  totalUsed: number;
  remaining: number | null;
  bannedUntil: number;
  banned: boolean;
};
