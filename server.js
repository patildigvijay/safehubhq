const express = require('express');
const path = require('path');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ============ SYSTEM PROMPT ============
const SYSTEM_PROMPT = `You are a senior HSE (Health, Safety and Environment) investigator with 20+ years of experience across mining, construction, rail, manufacturing, oil & gas, utilities, and industrial operations.

CRITICAL RULES — follow these without exception:
1. NEVER use the phrase "root cause" or "root cause analysis". Use: contributing factors, systemic factors, underlying factors, causal factors, or organisational factors instead.
2. NEVER blame or single out individuals. Focus entirely on systemic, procedural, and organisational factors.
3. NEVER invent facts. Do not fabricate names, dates, measurements, percentages, or specific details not present in the incident description. If a detail is missing, note it as an information gap.
4. Tag every finding as [FACT] (directly stated in the description), [INFERENCE] (reasonably inferred from the facts), or [PATTERN] (known industry pattern relevant to this incident type).
5. List information gaps explicitly — specific facts the investigator still needs to gather to complete a thorough investigation.
6. All corrective actions are SUGGESTED only. They may not be feasible without site-level context.
7. Focus analysis on contributing factors, systemic issues, and organisational conditions — not just immediate/proximate events.
8. This report is a structured first draft to save the investigator time. It is not a final report.

JURISDICTION-SPECIFIC REGULATORY REFERENCES:
- Australia: Work Health and Safety Act 2011 (Cth and state equivalents), Safe Work Australia codes of practice, state mining/rail/construction regulations (WHS Regs, mining regs by state)
- New Zealand: Health and Safety at Work Act 2015 (HSWA), WorkSafe NZ guidelines, approved codes of practice
- United Kingdom: Health and Safety at Work Act 1974, Management of Health and Safety at Work Regulations 1999, RIDDOR 2013, relevant HSE guidance documents
- Canada: Provincial OH&S legislation (BC: Workers Compensation Act / WorkSafeBC, Ontario: OHSA, Alberta: OHS Act, etc.), CCOHS standards
- United States: OSHA regulations (29 CFR 1910 General Industry / 1926 Construction), NIOSH guidance, ANSI standards, state OSHA programs where applicable

INVESTIGATION FRAMEWORKS YOU APPLY:
- ICAM (Incident Cause Analysis Method): Absent/Failed Defences, Individual/Team Actions, Task/Environmental Conditions, Organisational Factors
- 5 Whys causal chain: symptom level → procedural level → process level → organisational level → systemic level
- Hierarchy of Controls: Elimination, Substitution, Engineering, Administrative, PPE
- ISO 45001 principles`;

// ============ UNIQUE REFERENCE ID ============
function generateRefId() {
  const ts = Date.now().toString(36).toUpperCase().slice(-5);
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return 'SHQ-' + ts + rand;
}

// ============ ANALYSE ENDPOINT ============
app.post('/api/analyse', upload.array('files', 10), async (req, res) => {
  try {
    const { description, industry, incidentType, country, state, location, date, risks, hpiSif } = req.body;

    if (!description || !industry || !incidentType || !country) {
      return res.status(400).json({ error: 'Description, industry, incident type, and country are required.' });
    }

    let riskList = [];
    try { riskList = JSON.parse(risks || '[]'); } catch (_) {}

    // Process uploaded files
    let fileContext = '';
    if (req.files && req.files.length > 0) {
      fileContext = '\n\n--- UPLOADED SUPPORTING DOCUMENTS ---\n';
      for (const file of req.files) {
        fileContext += `\nDocument: ${file.originalname} (${file.mimetype})\n`;
        try {
          if (file.mimetype === 'application/pdf') {
            const pdfParse = require('pdf-parse');
            const data = await pdfParse(file.buffer);
            fileContext += `Content:\n${data.text.slice(0, 3000)}\n`;
          } else if (file.mimetype.includes('spreadsheet') || file.mimetype.includes('excel')) {
            const XLSX = require('xlsx');
            const wb = XLSX.read(file.buffer, { type: 'buffer' });
            const ws = wb.Sheets[wb.SheetNames[0]];
            fileContext += `Content (CSV):\n${XLSX.utils.sheet_to_csv(ws).slice(0, 3000)}\n`;
          } else if (file.mimetype.includes('wordprocessingml')) {
            const mammoth = require('mammoth');
            const result = await mammoth.extractRawText({ buffer: file.buffer });
            fileContext += `Content:\n${result.value.slice(0, 3000)}\n`;
          } else if (file.mimetype.startsWith('text/')) {
            fileContext += `Content:\n${file.buffer.toString('utf8').slice(0, 3000)}\n`;
          } else {
            fileContext += `[File type not extractable: ${file.mimetype}]\n`;
          }
        } catch (_) {
          fileContext += `[Could not extract text from this file]\n`;
        }
      }
      fileContext += '\n--- END OF UPLOADED DOCUMENTS ---\n';
    }

    const hpiNote = hpiSif === 'true'
      ? '\n\u26A0 HPI / SIF POTENTIAL: This incident has been flagged as a High Potential Incident or Serious Injury and Fatality potential event. Apply extra rigour to barrier analysis and systemic factors.'
      : '';
    const riskNote = riskList.length > 0 ? `\nRisk Areas Flagged: ${riskList.join(', ')}` : '';

    const userPrompt = `Conduct a thorough HSE incident investigation and return ONLY a valid JSON object — no markdown, no backticks, no preamble.

INCIDENT DETAILS:
Industry: ${industry}
Incident Type: ${incidentType}
Country: ${country}${state ? `\nState/Province: ${state}` : ''}${location ? `\nLocation: ${location}` : ''}${date ? `\nDate: ${date}` : ''}${riskNote}${hpiNote}

INCIDENT DESCRIPTION:
${description}
${fileContext}

Tag every finding as [FACT], [INFERENCE], or [PATTERN]. Never use "root cause" — use "contributing factor" or "systemic factor". Do not invent any specific details not provided. Reference ${country}-specific legislation only.

Return ONLY this JSON structure:

{
  "executiveSummary": "2-3 sentence summary: what happened, key findings, how many suggested actions",
  "incidentSequence": "Chronological reconstruction of events. 3-5 sentences. Use [FACT] and [INFERENCE] tags.",
  "immediateCauses": [
    "[FACT or INFERENCE] First immediate cause",
    "[FACT or INFERENCE] Second immediate cause"
  ],
  "contributingFactors": [
    "[FACT/INFERENCE/PATTERN] First contributing factor",
    "[FACT/INFERENCE/PATTERN] Second contributing factor",
    "[FACT/INFERENCE/PATTERN] Third contributing factor"
  ],
  "informationGaps": [
    "Gap 1: Specific fact still needed to complete investigation",
    "Gap 2: Another unknown that needs confirmation"
  ],
  "fiveWhys": [
    { "why": "Why did the incident occur?", "because": "[FACT] Direct answer" },
    { "why": "Why did that happen?", "because": "[INFERENCE] Procedural level" },
    { "why": "Why did that condition exist?", "because": "[INFERENCE] Process level" },
    { "why": "Why was that gap present?", "because": "[INFERENCE/PATTERN] Organisational level" },
    { "why": "Why has this not been addressed?", "because": "[INFERENCE/PATTERN] Deepest systemic factor" }
  ],
  "icam": {
    "absentFailedDefences": ["Specific defence that was absent or failed"],
    "individualTeamActions": ["Specific action or decision — describe the action, not the person"],
    "taskEnvironmentalConditions": ["Specific task or environmental condition"],
    "organisationalFactors": ["Specific organisational or systemic factor"]
  },
  "systemicFindings": [
    { "title": "Short title for finding 1", "detail": "Full explanation with [FACT/INFERENCE/PATTERN] tags" },
    { "title": "Short title for finding 2", "detail": "Full explanation" }
  ],
  "suggestedCorrectiveActions": [
    { "tier": "Elimination", "action": "Specific suggested action", "owner": "Role responsible", "due": "Timeframe" },
    { "tier": "Engineering", "action": "Specific suggested action", "owner": "Role responsible", "due": "Timeframe" },
    { "tier": "Administrative", "action": "Specific suggested action", "owner": "Role responsible", "due": "Timeframe" },
    { "tier": "Administrative", "action": "Second administrative control", "owner": "Role responsible", "due": "Timeframe" },
    { "tier": "PPE", "action": "Specific PPE control", "owner": "Role responsible", "due": "Timeframe" }
  ],
  "lessonsLearned": [
    "Lesson 1 — cross-site applicable",
    "Lesson 2",
    "Lesson 3"
  ],
  "regulatoryNotes": "Specific ${country} legislation, regulations, codes of practice, and standards relevant to this incident. Include notification obligations if applicable."
}`;

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const message = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 4000,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }]
    });

    const responseText = message.content[0].text.trim();
    let reportData;
    try {
      const cleaned = responseText
        .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
      reportData = JSON.parse(cleaned);
    } catch (e) {
      console.error('JSON parse error:', e, '\nResponse:', responseText.slice(0, 500));
      return res.status(500).json({ error: 'Failed to parse AI response. Please try again.' });
    }

    reportData.refId = generateRefId();
    reportData.date = new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' });
    reportData.industry = industry;
    reportData.type = incidentType;
    reportData.country = country;
    reportData.state = state || '';
    reportData.location = location || 'Not specified';
    reportData.description = description;

    res.json({ success: true, report: reportData });

  } catch (error) {
    console.error('Analysis error:', error);
    res.status(500).json({ error: 'Analysis failed. Please try again.', detail: error.message });
  }
});

// ============ GENERATE WORD DOCUMENT ============
app.post('/api/generate-docx', async (req, res) => {
  try {
    const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, BorderStyle, WidthType } = require('docx');
    const r = req.body.report;
    if (!r) return res.status(400).json({ error: 'Report data required.' });

    const BLUE = '1E4DD8', INK = '0A0E1A', MUTED = '5B6478', AMBER = '92400E';

    const sHead = (num, title) => new Paragraph({
      children: [new TextRun({ text: `${num}. ${title}`, bold: true, size: 28, color: BLUE, font: 'Calibri' })],
      spacing: { before: 400, after: 160 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: 'E8ECF2' } }
    });

    const bP = (text, bold = false) => new Paragraph({
      children: [new TextRun({ text: String(text || ''), size: 22, color: INK, font: 'Calibri', bold })],
      spacing: { after: 120 }
    });

    const cP = (label, text) => [
      new Paragraph({
        children: [new TextRun({ text: label, bold: true, size: 20, color: BLUE, font: 'Calibri' })],
        spacing: { before: 120, after: 40 }, indent: { left: 360 }
      }),
      new Paragraph({
        children: [new TextRun({ text: String(text || ''), size: 20, color: INK, font: 'Calibri' })],
        spacing: { after: 120 }, indent: { left: 360 }
      })
    ];

    const bullP = (text) => new Paragraph({
      children: [new TextRun({ text: String(text || ''), size: 20, color: INK, font: 'Calibri' })],
      bullet: { level: 0 }, spacing: { after: 80 }
    });

    const icamSections = [
      { label: 'Absent / Failed Defences', items: r.icam?.absentFailedDefences || r.icam?.defences || [] },
      { label: 'Individual / Team Actions', items: r.icam?.individualTeamActions || r.icam?.individual || [] },
      { label: 'Task / Environmental Conditions', items: r.icam?.taskEnvironmentalConditions || r.icam?.task || [] },
      { label: 'Organisational Factors', items: r.icam?.organisationalFactors || r.icam?.organisational || [] }
    ];

    const actionsTable = new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [
        new TableRow({
          tableHeader: true,
          children: [
            new TableCell({ width: { size: 18, type: WidthType.PERCENTAGE }, children: [new Paragraph({ children: [new TextRun({ text: 'Tier', bold: true, size: 20, font: 'Calibri' })] })] }),
            new TableCell({ width: { size: 47, type: WidthType.PERCENTAGE }, children: [new Paragraph({ children: [new TextRun({ text: 'Suggested Action', bold: true, size: 20, font: 'Calibri' })] })] }),
            new TableCell({ width: { size: 23, type: WidthType.PERCENTAGE }, children: [new Paragraph({ children: [new TextRun({ text: 'Owner', bold: true, size: 20, font: 'Calibri' })] })] }),
            new TableCell({ width: { size: 12, type: WidthType.PERCENTAGE }, children: [new Paragraph({ children: [new TextRun({ text: 'Due', bold: true, size: 20, font: 'Calibri' })] })] })
          ]
        }),
        ...(r.suggestedCorrectiveActions || r.correctiveActions || []).map(a =>
          new TableRow({
            children: [
              new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: a.tier || '', size: 20, font: 'Calibri', bold: true })] })] }),
              new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: a.action || '', size: 20, font: 'Calibri' })] })] }),
              new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: a.owner || '', size: 20, font: 'Calibri' })] })] }),
              new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: a.due || '', size: 20, font: 'Calibri' })] })] })
            ]
          })
        )
      ]
    });

    const doc = new Document({
      creator: 'Safehub HQ',
      title: `Investigation Report — ${r.industry || ''} — ${r.type || ''}`,
      sections: [{
        children: [
          new Paragraph({
            children: [
              new TextRun({ text: 'DRAFT — AI-GENERATED FIRST DRAFT', bold: true, size: 22, color: AMBER, font: 'Calibri' }),
              new TextRun({ text: '   Review and verify all findings with your investigation team before finalising or submitting.', size: 20, color: AMBER, font: 'Calibri' })
            ],
            spacing: { before: 0, after: 320 },
            shading: { type: 'clear', fill: 'FFFBEB' }
          }),
          new Paragraph({
            children: [new TextRun({ text: `${r.industry || 'Incident'} — ${r.type || 'Investigation'}`, bold: true, size: 44, color: INK, font: 'Calibri' })],
            spacing: { after: 160 }
          }),
          new Paragraph({
            children: [
              new TextRun({ text: `Ref: ${r.refId || 'N/A'}`, size: 20, color: MUTED, font: 'Calibri' }),
              new TextRun({ text: `   |   Date: ${r.date || 'N/A'}`, size: 20, color: MUTED, font: 'Calibri' }),
              new TextRun({ text: `   |   ${r.industry || ''}${r.country ? `   |   ${r.country}${r.state ? ', ' + r.state : ''}` : ''}`, size: 20, color: MUTED, font: 'Calibri' })
            ],
            spacing: { after: 480 }
          }),

          sHead(1, 'Executive Summary'),
          bP(r.executiveSummary || r.execSummary || ''),

          sHead(2, 'Incident Description & Sequence'),
          bP('Reported description:', true),
          bP(r.description || ''),
          bP('Reconstructed sequence:', true),
          bP(r.incidentSequence || r.sequence || ''),

          sHead(3, 'Immediate Causes'),
          bP('Direct actions and conditions that immediately preceded the incident.'),
          ...(r.immediateCauses || []).flatMap((c, i) => cP(`Cause ${i + 1}`, c)),

          sHead(4, 'Contributing Factors'),
          bP('Conditions that increased the likelihood or severity of the incident.'),
          ...(r.contributingFactors || []).flatMap((f, i) => cP(`Factor ${i + 1}`, f)),

          sHead(5, 'Information Gaps'),
          bP('Items the investigator still needs to confirm before finalising.'),
          ...(r.informationGaps || ['No specific gaps identified — review with investigation team']).map(g => bullP(g)),

          sHead(6, 'Causal Chain Analysis (5 Whys)'),
          bP('Iterative causal chain drilling from the immediate event to systemic factors.'),
          ...(r.fiveWhys || []).flatMap((w, i) => cP(`Why ${i + 1}: ${w.why}`, w.because)),

          sHead(7, 'ICAM Analysis'),
          bP('Incident Cause Analysis Method — categorising factors across four systemic layers.'),
          ...icamSections.flatMap(({ label, items }) => [
            new Paragraph({
              children: [new TextRun({ text: label, bold: true, size: 22, color: BLUE, font: 'Calibri' })],
              spacing: { before: 200, after: 80 }
            }),
            ...items.map(x => bullP(x))
          ]),

          sHead(8, 'Systemic Findings'),
          bP('Organisational and systemic factors identified through investigation.'),
          ...(r.systemicFindings || r.rootCauses || []).flatMap((f, i) => cP(`Finding ${i + 1} — ${f.title}`, f.detail)),

          sHead(9, 'Suggested Corrective Actions'),
          bP('These actions are suggested based on the information provided. Feasibility and prioritisation should be confirmed with site teams.'),
          actionsTable,
          new Paragraph({ children: [], spacing: { after: 200 } }),

          sHead(10, 'Lessons Learned'),
          bP('Cross-site applicable insights for preventing recurrence.'),
          ...(r.lessonsLearned || []).flatMap((l, i) => cP(`Lesson ${i + 1}`, l)),

          sHead(11, 'Regulatory & Compliance Notes'),
          bP(r.regulatoryNotes || r.regulatory || ''),

          new Paragraph({
            children: [new TextRun({ text: `Generated by Safehub HQ  |  Ref: ${r.refId || ''}  |  ${r.date || ''}`, size: 18, color: MUTED, font: 'Calibri', italics: true })],
            spacing: { before: 600 },
            border: { top: { style: BorderStyle.SINGLE, size: 2, color: 'E8ECF2' } }
          }),
          new Paragraph({
            children: [new TextRun({ text: 'This is an AI-generated first draft. It is not a substitute for a qualified investigation led by a trained HSE professional.', size: 18, color: MUTED, font: 'Calibri', italics: true })],
            spacing: { after: 0 }
          })
        ]
      }]
    });

    const buffer = await Packer.toBuffer(doc);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="Safehub-Investigation-${r.refId || 'Report'}.docx"`);
    res.send(buffer);

  } catch (error) {
    console.error('Docx error:', error);
    res.status(500).json({ error: 'Word document generation failed.', detail: error.message });
  }
});

// Fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Safehub HQ running on http://localhost:${PORT}`);
});
