'use client';
import { useParams } from 'next/navigation';
import DocumentViewer from '@/components/document-viewer';

// Просмотр документа базы знаний (поддерживает ?text=1 / ?original=1 / ?diff=N).
export default function KbDocumentViewPage() {
  const { id } = useParams<{ id: string }>();
  return <DocumentViewer basePath={`/kb/documents/${id}/view`} />;
}
