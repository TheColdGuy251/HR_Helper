'use client';
import { useParams } from 'next/navigation';
import DocumentViewer from '@/components/document-viewer';

// Просмотр шаблона документа (.docx — docx-preview, .pdf — нативно).
export default function KbTemplateViewPage() {
  const { id } = useParams<{ id: string }>();
  return <DocumentViewer basePath={`/kb/templates/${id}/view`} />;
}
