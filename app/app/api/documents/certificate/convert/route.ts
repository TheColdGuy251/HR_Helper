import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { badRequest, requireUser } from '@/lib/auth';
import {
  DocValueError,
  activeSheet,
  docLinks,
  errText,
  readForm,
  readWorkbook,
  requireFile,
  sheetRows,
  uploadSuffix,
} from '@/lib/docs/common';
import { createCertificate } from '@/lib/docs/employee-certificate';
import { extractWorkbookPhoto } from '@/lib/docs/workbook-image';

// Б3: выгрузка "Справка на сотрудника" из 1С:ЗиК -> читабельный docx.
//
// Старый .xls читает сам SheetJS, поэтому конвертация через LibreOffice
// здесь не нужна.

const XL_EXT = new Set(['.xls', '.xlsx', '.xlsm']);
/** Текст ошибки формата - как у остальных загрузок. */
const XL_LIST = '.xls/.xlsm/.xlsx';

export async function POST(request: NextRequest) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  const form = await readForm(request);
  if ('response' in form) return form.response;
  const file = requireFile(form.form);
  if (file instanceof NextResponse) return file;

  const suffix = uploadSuffix(file);
  if (!XL_EXT.has(suffix)) {
    return badRequest(`Неподдерживаемый формат: ${suffix || '?'} (нужен ${XL_LIST})`);
  }
  const data = Buffer.from(await file.arrayBuffer());
  if (data.length > 30 * 1024 * 1024) return badRequest('Файл больше 30 МБ');

  try {
    const rows = sheetRows(activeSheet(readWorkbook(data)));
    // Фото сотрудника из книги (для .xls - через LibreOffice); нет - пустая рамка.
    const photo = await extractWorkbookPhoto(data, suffix);
    const { rec, fields, warnings, photoUsed } = await createCertificate(gate.user.id, rows, photo);

    const preview: string[] = [];
    for (const name of ['Повышение квалификации', 'Работа по окончании ВУЗа']) {
      const val = fields[name];
      if (Array.isArray(val)) preview.push(`${name}: ${val.length} записей`);
    }
    preview.push(photoUsed ? 'фото из выгрузки добавлено' : 'фото в выгрузке не найдено — оставлена рамка под фото');
    return NextResponse.json({
      success: true,
      document_id: rec.id,
      title: rec.title,
      ...docLinks(rec.id),
      summary: preview.join('; ') || 'справка сформирована',
      warnings,
    });
  } catch (e) {
    if (e instanceof DocValueError) return badRequest(e.message);
    return NextResponse.json(
      { detail: `Не удалось сформировать справку: ${errText(e)}` },
      { status: 500 }
    );
  }
}
