export type LogRef = {
  id: string;
  name?: string;
  avatarUrl?: string;
};

export type LogCard = {
  title: string;
  avatarUrl?: string | null;
  information: string[];
  extra?: string;
};
