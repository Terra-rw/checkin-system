import { db } from './db.js';
import { filePath } from './media.js';
import { localParts, formatTime, formatDuration, weekdayOf, dateRange, toMinutes, daysInMonth } from './time.js';
import { loadPlanContext, contractSummary } from './schedule.js';

export const REPORT_TYPES = {
  daily: 'Daily log',
  summary: 'Summary per person',
  issues: 'Late, early & absent',
  hours: 'Hours vs contract',
};
const MAX_DAYS = 366;

const dur = (min) => (min ? formatDuration(min) : '—');
const prettyDate = (ymd) => {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
};
const hours2 = (min) => Math.round((min / 60) * 100) / 100;
const fmtDays = (n) => (n ? String(Math.round(n * 2) / 2) : '0');
const LEAVE_REASONS = new Set(['time_off', 'mission', 'pending', 'holiday']);

/**
 * Builds a report for one institution.
 * Returns { title, period, columns, rows, stats, warnings } where each row maps column key -> raw value.
 * Duration columns hold minutes; exporters format them as "1 hr 25 min".
 * `userIds` (array) limits the report to a manager's team; null = everyone.
 */
export function buildReport(inst, s, { type = 'summary', from, to, userId, userIds = null }) {
  if (!REPORT_TYPES[type]) type = 'summary';
  const nowParts = localParts(new Date(), s.timezone);
  const today = nowParts.date;
  if (!from || !to || from > to) throw Object.assign(new Error('Choose a valid date range.'), { status: 400 });
  if (dateRange(from, to).length > MAX_DAYS) throw Object.assign(new Error('Choose a range of one year or less.'), { status: 400 });

  let users = db
    .prepare(
      `SELECT id, name, email, active, created_at FROM users
       WHERE institution_id = ? AND role != 'owner' ${userId ? 'AND id = ?' : ''} ORDER BY name COLLATE NOCASE`,
    )
    .all(...(userId ? [inst.id, Number(userId)] : [inst.id]));
  // The day someone was added, in the institution's own time zone (not UTC), so nobody is absent before they existed.
  // SQLite's datetime('now') is UTC without a zone marker ("2026-11-14 22:36:03"); mark it as UTC before parsing.
  const utc = (v) => (/[zZ]$|[+-]\d\d:?\d\d$/.test(v) ? v : `${v.replace(' ', 'T')}Z`);
  for (const u of users) u.created = u.created_at ? localParts(new Date(utc(u.created_at)), s.timezone).date : '0000-00-00';
  if (Array.isArray(userIds)) {
    const allowed = new Set(userIds);
    users = users.filter((u) => allowed.has(u.id));
  }

  const records = db
    .prepare(
      `SELECT a.* FROM attendance a JOIN users u ON u.id = a.user_id
       WHERE u.institution_id = ? AND a.date BETWEEN ? AND ?`,
    )
    .all(inst.id, from, to);
  const byKey = new Map(records.map((r) => [`${r.user_id}|${r.date}`, r]));

  const ctx = loadPlanContext(inst.id, s, from, to);
  const lastDay = to < today ? to : today;
  const days = dateRange(from, to);
  const pastDays = from <= lastDay ? dateRange(from, lastDay) : [];
  const workDayCount = pastDays.filter((d) => s.workDays.includes(weekdayOf(d)) && !ctx.holidayOn(d)).length;
  const worked = (r) =>
    r.check_out_at ? Math.max(0, Math.round((new Date(r.check_out_at) - new Date(r.check_in_at)) / 60000)) : 0;
  const deadlinePassed = (date, plan) => date < today || (date === today && nowParts.minutes >= toMinutes(plan.start) + s.graceMinutes);

  const base = {
    type,
    title: REPORT_TYPES[type],
    institution: inst.name,
    logoPath: filePath(inst.logo_file),
    officeName: s.officeName,
    timezone: s.timezone,
    from,
    to,
    period: from === to ? prettyDate(from) : `${prettyDate(from)} – ${prettyDate(to)}`,
    workDayCount,
    warnings: [],
  };

  if (type === 'hours') return { ...base, ...hoursReport({ users, ctx, s, pastDays, byKey, worked, lastDay }) };

  const daily = [];
  const summary = [];
  const wantDaily = type !== 'summary'; // the summary only needs the totals, not a formatted row per day
  for (const u of users) {
    const sum = { name: u.name, email: u.email, present: 0, absent: 0, lateDays: 0, lateMin: 0, earlyCount: 0, workedMin: 0, leaveDays: 0, missionDays: 0 };
    let any = false;
    for (const date of days) {
      const r = byKey.get(`${u.id}|${date}`);
      if (!r && (date > lastDay || date < u.created || !u.active)) continue;
      const plan = ctx.dayPlan(u.id, date);
      if (plan.reason === 'time_off' || plan.offFraction) sum.leaveDays += plan.reason === 'holiday' ? 0 : plan.offFraction;
      if (plan.creditFraction) sum.missionDays += plan.creditFraction;
      if (!r) {
        if (plan.expected) {
          if (!deadlinePassed(date, plan)) continue;
          sum.absent++;
          any = true;
          if (wantDaily) daily.push({ date, name: u.name, email: u.email, checkIn: '', checkOut: '', status: 'Absent', lateMin: 0, earlyMin: 0, workedMin: 0 });
        } else if (LEAVE_REASONS.has(plan.reason) && plan.workingDay) {
          any = true;
          if (wantDaily) daily.push({ date, name: u.name, email: u.email, checkIn: '', checkOut: '', status: plan.label, lateMin: 0, earlyMin: 0, workedMin: 0 });
        }
        continue;
      }
      any = true;
      const w = worked(r);
      sum.present++;
      sum.workedMin += w;
      if (r.late) {
        sum.lateDays++;
        sum.lateMin += r.late_minutes;
      }
      if (r.early) sum.earlyCount++;
      if (!wantDaily) continue;
      const flags = [r.late ? 'Late' : null, r.early ? 'Left early' : null, !r.check_out_at && date < today ? 'No check-out' : null].filter(Boolean);
      let status = flags.join(', ') || (plan.expected ? 'On time' : plan.flexible ? 'Flexible' : `Worked (${plan.label.toLowerCase()})`);
      if (r.source && r.source !== 'gps') status += ' · edited';
      daily.push({
        date,
        name: u.name,
        email: u.email,
        checkIn: formatTime(r.check_in_at, s.timezone),
        checkOut: r.check_out_at ? formatTime(r.check_out_at, s.timezone) : '',
        status,
        lateMin: r.late_minutes,
        earlyMin: r.early_minutes,
        workedMin: w,
      });
    }
    if (any || u.active) summary.push({ ...sum, leaveDays: fmtDays(sum.leaveDays), missionDays: fmtDays(sum.missionDays) });
  }
  // People are already in name order and sort() is stable, so sorting by date alone keeps names A–Z within each day.
  daily.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const expectedTotal = summary.reduce((n, r) => n + r.present + r.absent, 0);
  const presentTotal = summary.reduce((n, r) => n + r.present, 0);
  const stats = [
    { label: 'Attendance rate', value: expectedTotal ? `${Math.round((presentTotal / expectedTotal) * 100)}%` : '—' },
    { label: 'Late arrivals', value: String(summary.reduce((n, r) => n + r.lateDays, 0)) },
    { label: 'Total time late', value: dur(summary.reduce((n, r) => n + r.lateMin, 0)) },
    { label: 'Early check-outs', value: String(summary.reduce((n, r) => n + r.earlyCount, 0)) },
  ];

  const dailyColumns = [
    { key: 'date', label: 'Date', type: 'date', width: 14 },
    { key: 'name', label: 'Name', type: 'text', width: 24 },
    { key: 'email', label: 'Email', type: 'text', width: 28 },
    { key: 'checkIn', label: 'Check in', type: 'text', width: 10 },
    { key: 'checkOut', label: 'Check out', type: 'text', width: 10 },
    { key: 'status', label: 'Status', type: 'text', width: 22 },
    { key: 'lateMin', label: 'Late by', type: 'duration', width: 14 },
    { key: 'earlyMin', label: 'Left early by', type: 'duration', width: 14 },
    { key: 'workedMin', label: 'Worked', type: 'duration', width: 14 },
  ];

  let columns;
  let rows;
  if (type === 'summary') {
    columns = [
      { key: 'name', label: 'Name', type: 'text', width: 24 },
      { key: 'email', label: 'Email', type: 'text', width: 26 },
      { key: 'present', label: 'Present', type: 'number', width: 10 },
      { key: 'absent', label: 'Absent', type: 'number', width: 10 },
      { key: 'leaveDays', label: 'Leave days', type: 'number', width: 11 },
      { key: 'missionDays', label: 'Mission days', type: 'number', width: 12 },
      { key: 'lateDays', label: 'Late days', type: 'number', width: 11 },
      { key: 'lateMin', label: 'Total late', type: 'duration', width: 14 },
      { key: 'earlyCount', label: 'Left early', type: 'number', width: 11 },
      { key: 'workedMin', label: 'Hours worked', type: 'duration', width: 16 },
    ];
    rows = summary;
  } else {
    columns = dailyColumns;
    rows = type === 'issues' ? daily.filter((r) => /Late|Left early|Absent|No check-out/.test(r.status)) : daily;
  }
  return { ...base, columns, rows, stats };
}

/** Part-timers' hours against their contract (see the design: prorated by day, leave/holidays reduce it). */
function hoursReport({ users, ctx, s, pastDays, byKey, worked, lastDay }) {
  const workdaysInMonth = new Map();
  const instWorkdays = (ymd) => {
    const key = ymd.slice(0, 7);
    if (!workdaysInMonth.has(key)) {
      const n = daysInMonth(ymd);
      let c = 0;
      for (let d = 1; d <= n; d++) if (s.workDays.includes(weekdayOf(`${key}-${String(d).padStart(2, '0')}`))) c++;
      workdaysInMonth.set(key, c || 1);
    }
    return workdaysInMonth.get(key);
  };

  const rows = [];
  let missingTotal = 0;
  for (const u of users) {
    let target = 0;
    let workedMin = 0;
    let leave = 0;
    let daysWorked = 0;
    let missing = 0;
    let edited = 0;
    let isPart = false;
    let latest = null;
    for (const date of pastDays) {
      const terms = ctx.termsFor(u.id, date);
      if (terms?.employment_type !== 'part_time' || !terms.contract_minutes) continue;
      isPart = true;
      latest = terms;
      const c = terms.contract_minutes;
      const weekly = terms.contract_period !== 'month';
      target += weekly ? c / 7 : c / daysInMonth(date);
      const plan = ctx.dayPlan(u.id, date);
      const dayValue = plan.flexible ? (weekly ? c / (s.workDays.length || 5) : c / instWorkdays(date)) : plan.baseMinutes || 0;
      if (plan.offFraction) {
        target -= plan.offFraction * dayValue;
        if (plan.reason !== 'holiday') leave += plan.offFraction;
      }
      const r = byKey.get(`${u.id}|${date}`);
      if (r) {
        if (r.source && r.source !== 'gps') edited++;
        if (r.check_out_at) {
          workedMin += worked(r);
          daysWorked++;
        } else if (date < lastDay || r.date < lastDay) {
          missing++;
        }
      } else if (plan.creditFraction) {
        workedMin += plan.creditFraction * dayValue;
      }
    }
    if (!isPart) continue;
    target = Math.max(0, Math.round(target));
    workedMin = Math.round(workedMin);
    const diff = workedMin - target;
    missingTotal += missing;
    rows.push({
      name: u.name,
      email: u.email,
      contract: contractSummary(latest, s),
      targetMin: target,
      workedMin,
      difference: diff === 0 ? 'On target' : diff < 0 ? `${formatDuration(-diff)} under` : `${formatDuration(diff)} over`,
      workedHours: hours2(workedMin),
      differenceHours: hours2(diff),
      leaveDays: fmtDays(leave),
      daysWorked,
      missing,
      edited,
    });
  }

  const columns = [
    { key: 'name', label: 'Name', type: 'text', width: 22 },
    { key: 'contract', label: 'Contract', type: 'text', width: 18 },
    { key: 'targetMin', label: 'Contract hours', type: 'duration', width: 14 },
    { key: 'workedMin', label: 'Worked', type: 'duration', width: 14 },
    { key: 'difference', label: 'Difference', type: 'text', width: 18 },
    { key: 'workedHours', label: 'Worked (decimal hrs)', type: 'number', width: 12 },
    { key: 'differenceHours', label: 'Difference (decimal hrs)', type: 'number', width: 12 },
    { key: 'leaveDays', label: 'Leave days', type: 'number', width: 10 },
    { key: 'daysWorked', label: 'Days worked', type: 'number', width: 10 },
    { key: 'missing', label: 'Missing check-outs', type: 'number', width: 12 },
    { key: 'edited', label: 'Edited days', type: 'number', width: 10 },
  ];
  const stats = [
    { label: 'Part-time people', value: String(rows.length) },
    { label: 'Total worked', value: dur(rows.reduce((n, r) => n + r.workedMin, 0)) },
    { label: 'Under contract', value: String(rows.filter((r) => r.differenceHours < 0).length) },
    { label: 'Missing check-outs', value: String(missingTotal) },
  ];
  const warnings = missingTotal
    ? [`${missingTotal} missing check-out${missingTotal === 1 ? '' : 's'}. Hours for those days count as 0 until they're fixed.`]
    : [];
  return { columns, rows, stats, warnings };
}

/** Text shown for a cell (UI preview, PDF). */
export function displayCell(col, value) {
  if (col.type === 'duration') return dur(value);
  if (col.type === 'date') {
    const [y, m, d] = value.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  }
  return value === '' || value == null ? '—' : String(value);
}

export function reportFileName(report, ext) {
  return `attendance-${report.type}-${report.from}_${report.to}.${ext}`;
}

// ---------------------------------------------------------------- CSV

export function toCsv(report) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const header = [];
  for (const c of report.columns) {
    header.push(c.label);
    if (c.type === 'duration') header.push(`${c.label} (min)`);
  }
  const lines = report.rows.map((r) => {
    const cells = [];
    for (const c of report.columns) {
      if (c.type === 'duration') cells.push(r[c.key] ? formatDuration(r[c.key]) : '', r[c.key] || 0);
      else cells.push(r[c.key]);
    }
    return cells.map(esc).join(',');
  });
  // BOM so Excel opens accented names correctly.
  return '﻿' + [header.map(esc).join(','), ...lines].join('\r\n');
}

// ---------------------------------------------------------------- Excel

export async function toXlsx(report) {
  const { default: ExcelJS } = await import('exceljs'); // loaded on first use: keeps startup fast
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Check-in';
  const ws = wb.addWorksheet(report.title.slice(0, 31), { views: [{ state: 'frozen', ySplit: 5 }] });

  const cols = [];
  for (const c of report.columns) {
    cols.push({ ...c, mode: 'display' });
    if (c.type === 'duration') cols.push({ ...c, mode: 'minutes' });
  }
  ws.columns = cols.map((c) => ({ width: c.mode === 'minutes' ? 12 : c.width, hidden: c.mode === 'minutes' }));

  ws.addRow([`${report.institution} · ${report.title}`]).font = { bold: true, size: 14 };
  ws.addRow([`${report.period} · ${report.workDayCount} work days · times in ${report.timezone}`]);
  ws.addRow([report.stats.map((s) => `${s.label}: ${s.value}`).join('   ·   ')]);
  ws.addRow([]);

  const header = ws.addRow(cols.map((c) => (c.mode === 'minutes' ? `${c.label} (min)` : c.label)));
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F766E' } };
  });

  for (const r of report.rows) {
    ws.addRow(
      cols.map((c) => {
        const v = r[c.key];
        if (c.mode === 'minutes') return v || 0;
        if (c.type === 'duration') return v ? formatDuration(v) : '';
        return v;
      }),
    );
  }
  ws.autoFilter = { from: { row: 5, column: 1 }, to: { row: 5, column: cols.length } };

  // Logo at the top right, over the title rows.
  if (report.logoPath) {
    const lastVisible = cols.map((c) => c.mode).lastIndexOf('display');
    const imageId = wb.addImage({ filename: report.logoPath, extension: report.logoPath.endsWith('.png') ? 'png' : 'jpeg' });
    ws.getRow(1).height = 30;
    ws.addImage(imageId, { tl: { col: lastVisible + 0.4, row: 0.1 }, ext: { width: 44, height: 44 }, editAs: 'oneCell' });
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ---------------------------------------------------------------- PDF

export async function toPdf(report, generatedBy) {
  const { default: PDFDocument } = await import('pdfkit');
  return new Promise((resolve, reject) => {
    const landscape = report.columns.length > 8;
    const doc = new PDFDocument({ size: 'A4', layout: landscape ? 'landscape' : 'portrait', margin: 40, bufferPages: true });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const teal = '#0f766e';
    const muted = '#4b5563';
    const left = doc.page.margins.left;
    const width = doc.page.width - left - doc.page.margins.right;
    const bottom = () => doc.page.height - doc.page.margins.bottom - 30;

    // Header
    let nameX = left;
    if (report.logoPath) {
      try {
        doc.image(report.logoPath, left, 36, { fit: [38, 38], align: 'center', valign: 'center' });
        nameX = left + 48;
      } catch {
        /* unreadable image: fall back to the name only */
      }
    }
    doc.fillColor('#17202a').font('Helvetica-Bold').fontSize(15).text(report.institution, nameX, 40);
    doc.font('Helvetica').fontSize(10).fillColor(muted).text(report.officeName, nameX);
    doc.font('Helvetica-Bold').fontSize(17).fillColor('#17202a').text(report.title, left, 40, { width, align: 'right' });
    doc.font('Helvetica').fontSize(10).fillColor(muted).text(`${report.period} · ${report.workDayCount} work days`, { width, align: 'right' });
    doc.moveTo(left, 82).lineTo(left + width, 82).lineWidth(2).strokeColor(teal).stroke();

    // Stat boxes
    let y = 96;
    const boxW = (width - 3 * 10) / 4;
    report.stats.forEach((s, i) => {
      const x = left + i * (boxW + 10);
      doc.roundedRect(x, y, boxW, 46, 6).lineWidth(1).strokeColor('#e2e8f0').stroke();
      doc.font('Helvetica-Bold').fontSize(14).fillColor('#17202a').text(s.value, x + 10, y + 8, { width: boxW - 20 });
      doc.font('Helvetica').fontSize(9).fillColor(muted).text(s.label, x + 10, y + 28, { width: boxW - 20 });
    });
    y += 62;

    // Table
    const totalWeight = report.columns.reduce((n, c) => n + c.width, 0);
    const widths = report.columns.map((c) => (c.width / totalWeight) * width);
    const rightAligned = (c) => c.type === 'number' || c.type === 'duration';

    const drawHeader = () => {
      doc.rect(left, y, width, 20).fill('#f4f6f8');
      let x = left;
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#17202a');
      report.columns.forEach((c, i) => {
        doc.text(c.label, x + 4, y + 6, { width: widths[i] - 8, align: rightAligned(c) ? 'right' : 'left', lineBreak: false });
        x += widths[i];
      });
      y += 20;
    };
    drawHeader();

    doc.font('Helvetica').fontSize(8.5);
    if (report.rows.length === 0) {
      doc.fillColor(muted).text('No records for this period.', left, y + 8);
      y += 28;
    }
    for (const r of report.rows) {
      if (y + 18 > bottom()) {
        doc.addPage();
        y = doc.page.margins.top;
        drawHeader();
        doc.font('Helvetica').fontSize(8.5);
      }
      let x = left;
      doc.fillColor('#17202a');
      report.columns.forEach((c, i) => {
        doc.text(displayCell(c, r[c.key]), x + 4, y + 5, { width: widths[i] - 8, align: rightAligned(c) ? 'right' : 'left', lineBreak: false, ellipsis: true });
        x += widths[i];
      });
      y += 18;
      doc.moveTo(left, y).lineTo(left + width, y).lineWidth(0.5).strokeColor('#e2e8f0').stroke();
    }

    // Signature lines
    if (y + 80 > bottom()) {
      doc.addPage();
      y = doc.page.margins.top;
    }
    y = Math.max(y + 40, bottom() - 50);
    const sigW = (width - 48) / 2;
    ['Prepared by (name, signature, date)', 'Approved by (name, signature, date)'].forEach((label, i) => {
      const x = left + i * (sigW + 48);
      doc.moveTo(x, y).lineTo(x + sigW, y).lineWidth(0.8).strokeColor('#17202a').stroke();
      doc.font('Helvetica').fontSize(9).fillColor(muted).text(label, x, y + 5, { width: sigW });
    });

    // Footer on every page
    const generated = `Generated ${new Date().toLocaleString('en-GB', { timeZone: report.timezone, dateStyle: 'medium', timeStyle: 'short' })} (${report.timezone}) by ${generatedBy}`;
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(i);
      const fy = doc.page.height - doc.page.margins.bottom - 12;
      doc.font('Helvetica').fontSize(8).fillColor(muted);
      doc.text(generated, left, fy, { width: width * 0.7, lineBreak: false });
      doc.text(`Page ${i + 1} of ${range.count}`, left, fy, { width, align: 'right', lineBreak: false });
    }
    doc.end();
  });
}

export async function exportReport(report, format, generatedBy) {
  if (format === 'csv') return { buffer: Buffer.from(toCsv(report), 'utf8'), type: 'text/csv; charset=utf-8', ext: 'csv' };
  if (format === 'pdf') return { buffer: await toPdf(report, generatedBy), type: 'application/pdf', ext: 'pdf' };
  return {
    buffer: await toXlsx(report),
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ext: 'xlsx',
  };
}
