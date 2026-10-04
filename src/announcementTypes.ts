export interface Announcement {
  id: string;
  title: string;
  body: string;
  status: 'draft' | 'published';
  revision: number;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
}
