'use client';
import { useParams } from 'next/navigation';
import DocumentViewer from '@/components/document-viewer';

// Просмотр файла, прикреплённого к новости.
export default function NewsMediaViewPage() {
  const { id } = useParams<{ id: string }>();
  return <DocumentViewer basePath={`/news/media/${id}/view`} />;
}
