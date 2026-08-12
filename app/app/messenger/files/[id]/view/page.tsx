'use client';
import { useParams } from 'next/navigation';
import DocumentViewer from '@/components/document-viewer';

// Просмотр файла, отправленного в мессенджере.
export default function MessengerFileViewPage() {
  const { id } = useParams<{ id: string }>();
  return <DocumentViewer basePath={`/messenger/files/${id}/view`} />;
}
