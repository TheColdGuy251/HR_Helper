'use client';
import { useState } from 'react';
import { Database, FileText, Globe, Layout, MessageSquare, Users } from 'lucide-react';
import { useAuth } from '@/components/auth-context';
import { PageHeader, PageShell, UnderlineTabs } from '@/components/ui';
import DocsTab from '@/components/kb/docs-tab';
import SourcesTab from '@/components/kb/sources-tab';
import TemplatesTab from '@/components/kb/templates-tab';
import PiiTab from '@/components/kb/pii-tab';
import FaqTab from '@/components/kb/faq-tab';

// База знаний: документы, веб-источники, шаблоны, ПДн и FAQ (порт kb.html/kb.js).

type TabKey = 'documents' | 'sources' | 'templates' | 'personal' | 'faq';

export default function KbPage() {
  const { user, loading } = useAuth();
  const [tab, setTab] = useState<TabKey>('documents');

  if (loading) {
    return (
      <PageShell wide>
        <p className="text-center text-gray-400 py-16">Загрузка...</p>
      </PageShell>
    );
  }

  const canEdit = !!user && (user.is_admin || user.is_kb_editor);

  const tabs: { key: TabKey; label: string; icon: typeof FileText }[] = [
    { key: 'documents', label: 'Документы', icon: FileText },
    { key: 'sources', label: 'Веб-источники', icon: Globe },
    { key: 'templates', label: 'Шаблоны', icon: Layout },
    { key: 'personal', label: 'Персональные данные', icon: Users },
  ];
  if (canEdit) tabs.push({ key: 'faq', label: 'FAQ', icon: MessageSquare });

  return (
    <PageShell wide>
      <PageHeader
        icon={Database}
        title="База знаний"
        subtitle="Локальные акты, регламенты, веб-источники, шаблоны и персональные данные сотрудников."
      />

      <UnderlineTabs tabs={tabs} active={tab} onChange={setTab} />

      {tab === 'documents' && <DocsTab canEdit={canEdit} />}
      {tab === 'sources' && <SourcesTab canEdit={canEdit} />}
      {tab === 'templates' && <TemplatesTab canEdit={canEdit} />}
      {tab === 'personal' && <PiiTab />}
      {tab === 'faq' && canEdit && <FaqTab isAdmin={!!user?.is_admin} />}
    </PageShell>
  );
}
