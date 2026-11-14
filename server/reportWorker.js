// Runs inside a worker thread (see reportJobs.js). Builds reports and exports them,
// so large reports never block check-ins and page loads on the main thread.
import { parentPort } from 'node:worker_threads';
import { db, getSettings } from './db.js';
import { buildReport, displayCell, exportReport, reportFileName } from './reports.js';

const PDF_MAX_ROWS = 15000; // beyond this a PDF is hundreds of pages; Excel/CSV are the right tools
const PREVIEW_ROWS = 50;

const fail = (status, message) => Object.assign(new Error(message), { status });

async function handle(job) {
  const inst = db.prepare('SELECT * FROM institutions WHERE id = ?').get(job.instId);
  if (!inst) throw fail(404, 'Institution not found.');
  const report = buildReport(inst, getSettings(inst.id), job.query);
  const summary = { title: report.title, period: report.period, workDayCount: report.workDayCount, stats: report.stats };

  if (job.task === 'preview') {
    return {
      result: {
        ...summary,
        columns: report.columns.map(({ key, label, type }) => ({ key, label, type })),
        total: report.rows.length,
        rows: report.rows.slice(0, PREVIEW_ROWS).map((r) => Object.fromEntries(report.columns.map((c) => [c.key, displayCell(c, r[c.key])]))),
      },
    };
  }

  if (job.format === 'pdf' && report.rows.length > PDF_MAX_ROWS) {
    throw fail(
      400,
      `This report has ${report.rows.length.toLocaleString('en')} rows, too many for a PDF (limit ${PDF_MAX_ROWS.toLocaleString('en')}). ` +
        'Download it as Excel or CSV, or choose a shorter period.',
    );
  }
  const file = await exportReport(report, job.format, job.generatedBy);
  // Copy into a standalone ArrayBuffer so it can be handed to the main thread without copying again.
  const buffer = file.buffer.buffer.slice(file.buffer.byteOffset, file.buffer.byteOffset + file.buffer.byteLength);
  return {
    result: { ...summary, type: file.type, ext: file.ext, fileName: reportFileName(report, file.ext), buffer },
    transfer: [buffer],
  };
}

parentPort.on('message', async (job) => {
  try {
    const { result, transfer } = await handle(job);
    parentPort.postMessage({ id: job.id, ok: true, result }, transfer || []);
  } catch (err) {
    if (!err.status) console.error('[reports] worker error:', err);
    parentPort.postMessage({ id: job.id, ok: false, status: err.status || 500, message: err.status ? err.message : 'The report could not be built.' });
  }
});
