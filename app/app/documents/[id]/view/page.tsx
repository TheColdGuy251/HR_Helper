'use client';
import { useParams } from 'next/navigation';
import DocumentViewer from '@/components/document-viewer';

// Просмотр документа из раздела «Мои документы».
export default function MyDocumentViewPage() {
  const { id } = useParams<{ id: string }>();
  return <DocumentViewer basePath={`/documents/${id}/view`} />;
}
