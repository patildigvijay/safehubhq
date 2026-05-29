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
2. NEVER blame or single out individuals. Focus entirely on systemic, procedural, and organisational factors. Refer to people by role (e.g. "the operator", "the supervisor", "the maintenance fitter"), never by name even if a name is provided in the input.
3. NEVER MANUFACTURE FACTS. This is the most important rule. Do not invent, infer, or fabricate:
   - Names of people, sites, equipment, or companies that aren't in the input
   - Specific dates, times, measurements, distances, weights, or percentages
   - Quoted statements or witness accounts
   - Procedures, training records, or maintenance histories
   - Any "facts" the input does not contain
   If a relevant detail is not present, list it as an information gap. NEVER fill the gap with a plausible-sounding invention.
4. Tag every finding as [FACT] (directly stated in the input or visible in an uploaded image), [INFERENCE] (reasonably inferred from the stated facts, with reasoning), or [PATTERN] (a known industry pattern relevant to this incident type, not specific to this case). Use these tags inline in every finding.
5. List information gaps explicitly in the dedicated section — every specific fact the investigator still needs to gather to complete the investigation.
6. All corrective actions are SUGGESTED only. They may not be feasible without site-level context.
7. Focus analysis on contributing factors, systemic issues, and organisational conditions — not just immediate/proximate events.
8. This report is a structured first draft to save the investigator time. It is not a final report.

PARSING USER INPUT — important:
Users may paste anything into the "What happened?" field, including:
- A raw narrative paragraph
- A structured incident report copy-pasted from their internal system (with field labels like "Reported By:", "Event Date/Time:", "Event Description:", "Immediate Action:", "Section:", "Was this a SIF event?:", etc.)
- A mix of narrative and bullet points
- Notes with abbreviations and incomplete sentences

You MUST:
- Extract every relevant fact from the input regardless of format
- Use structured field values intelligently (e.g. "Event Date/Time: 17/07/2025 08:30" tells you the date and time)
- Recognise classifications already made by the user's internal system (e.g. "Non-SIF", "Category 5", "Critical Risk: No") and treat them as user-provided facts
- Pull narrative details from the event description into your analysis
- Note immediate actions already taken (e.g. first aid given, hospital visit) as facts, not inventions
- Ignore irrelevant metadata (system field labels, review status flags) when writing the clean narrative
- If a photo or document is uploaded, extract every relevant detail you can see — equipment visible, conditions, text/labels in the image, environment

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
    const { description, incidentType, location, date } = req.body;

    if (!description || !incidentType) {
      return res.status(400).json({ error: 'Description and at least one incident type are required.' });
    }

    let typeList = [];
    try { typeList = JSON.parse(incidentType); if (!Array.isArray(typeList)) typeList = [incidentType]; }
    catch (_) { typeList = [incidentType]; }
    const incidentTypeStr = typeList.join(', ');

    // Process uploaded files — text from docs, base64 for images (vision)
    let fileContext = '';
    const imageBlocks = [];  // For Claude vision
    const SUPPORTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5 MB per image (Claude vision limit)
    const MAX_IMAGES = 6;

    if (req.files && req.files.length > 0) {
      fileContext = '\n\n--- UPLOADED SUPPORTING DOCUMENTS ---\n';
      let imageCount = 0;

      for (const file of req.files) {
        fileContext += `\nFile: ${file.originalname} (${file.mimetype})\n`;
        try {
          if (file.mimetype === 'application/pdf') {
            const pdfParse = require('pdf-parse');
            const data = await pdfParse(file.buffer);
            fileContext += `Content:\n${data.text.slice(0, 4000)}\n`;
          } else if (file.mimetype.includes('spreadsheet') || file.mimetype.includes('excel')) {
            const XLSX = require('xlsx');
            const wb = XLSX.read(file.buffer, { type: 'buffer' });
            const ws = wb.Sheets[wb.SheetNames[0]];
            fileContext += `Content (CSV):\n${XLSX.utils.sheet_to_csv(ws).slice(0, 4000)}\n`;
          } else if (file.mimetype.includes('wordprocessingml')) {
            const mammoth = require('mammoth');
            const result = await mammoth.extractRawText({ buffer: file.buffer });
            fileContext += `Content:\n${result.value.slice(0, 4000)}\n`;
          } else if (SUPPORTED_IMAGE_TYPES.includes(file.mimetype)) {
            if (imageCount >= MAX_IMAGES) {
              fileContext += `[Image skipped — maximum ${MAX_IMAGES} images per investigation]\n`;
            } else if (file.buffer.length > MAX_IMAGE_SIZE) {
              fileContext += `[Image too large for vision analysis — ${(file.buffer.length / 1024 / 1024).toFixed(1)} MB, max 5 MB]\n`;
            } else {
              imageBlocks.push({
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: file.mimetype,
                  data: file.buffer.toString('base64')
                }
              });
              fileContext += `[Image attached for visual analysis — see image ${imageCount + 1}]\n`;
              imageCount++;
            }
          } else if (file.mimetype.startsWith('text/')) {
            fileContext += `Content:\n${file.buffer.toString('utf8').slice(0, 4000)}\n`;
          } else {
            fileContext += `[File type not extractable: ${file.mimetype}]\n`;
          }
        } catch (_) {
          fileContext += `[Could not extract content from this file]\n`;
        }
      }
      fileContext += '\n--- END OF UPLOADED DOCUMENTS ---\n';
    }

    const visionNote = imageBlocks.length > 0
      ? `\n\nIMPORTANT: ${imageBlocks.length} image${imageBlocks.length > 1 ? 's have' : ' has'} been attached. Examine ${imageBlocks.length > 1 ? 'each one' : 'it'} carefully and extract every relevant detail: equipment visible, conditions, text or labels in the image, environment, anything that could inform the investigation. Treat anything you can clearly see as a [FACT]. Do not speculate about what is not visible.`
      : '';

    const userPromptText = `Conduct a thorough HSE incident investigation and return ONLY a valid JSON object — no markdown, no backticks, no preamble.

User-provided incident type(s): ${incidentTypeStr}${location ? `\nLocation: ${location}` : ''}${date ? `\nDate: ${date}` : ''}

WHAT HAPPENED AND ANY OTHER DETAILS (may be a raw narrative OR a structured paste from the user's internal incident system — extract every relevant fact):
${description}
${fileContext}${visionNote}

AUTO-DETECTION FROM INPUT:
You must detect the following from the description (and any uploaded documents/images). If you cannot reasonably determine a value, set it to "Unknown" or [] — do NOT guess wildly. Tag your confidence honestly.

- detectedIndustry: e.g. "Mining", "Rail / Transport", "Construction", "Manufacturing", "Oil & Gas", "Utilities", "Healthcare", "Warehousing / Logistics", "Agriculture", or "Other / Unknown"
- detectedCountry: One of "Australia", "New Zealand", "United Kingdom", "Canada", "United States", or "Unknown". Infer from terminology (e.g. "WHS Act" or "Aurizon" or "QLD" → Australia; "HSWA" → NZ; "OSHA" → US; "RIDDOR" → UK; "WorkSafeBC" → Canada). If no jurisdiction signals are present, set Unknown.
- detectedState: State or province if mentioned, else ""
- detectedRiskAreas: Array of any of these that apply based on the incident: "Confined space", "Working at height", "Moving plant / machinery", "Stored energy", "Electrical", "Hot work", "Hazardous substances", "Lifting operations", "Excavation / ground collapse", "Slip / trip / fall", "Vehicle / traffic", "Fatigue", "Manual handling". Only include those clearly evident from the input.
- detectedHpiSif: true ONLY if the incident clearly involved or had potential for serious injury or fatality (e.g. fatality, permanent injury, near-miss with severe potential). Otherwise false.

Tag every finding as [FACT], [INFERENCE], or [PATTERN]. Never use "root cause". Never invent specifics not in the input or visible in attached images. Refer to people by role only, never by name.

For regulatory references, use the detected country's legislation. If country is Unknown, write general principles applicable across jurisdictions.

The "cleanDescription" field is critical: extract a concise narrative of what happened from whatever the user provided. If they pasted a structured form dump, distil it into a clean 3-6 sentence incident description. Do not include field labels like "Reported By" or system metadata. Do not include the user's own assessments (like "Critical Risk Review" status) — those go elsewhere.

Return ONLY this JSON structure:

{
  "detectedIndustry": "e.g. Mining, or Unknown if not clear",
  "detectedCountry": "Australia / New Zealand / United Kingdom / Canada / United States / Unknown",
  "detectedState": "State or province if mentioned, else empty string",
  "detectedRiskAreas": ["risk area 1", "risk area 2"],
  "detectedHpiSif": false,
  "cleanDescription": "Concise 3-6 sentence incident narrative extracted from the input. Plain prose. No field labels, no system metadata, no names of individuals.",
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
  "regulatoryNotes": "Legislation, regulations, codes of practice, and standards relevant to this incident in the detected country. Include notification obligations if applicable."
}`;

    // Build multi-modal content array — images first, then text prompt
    const userContent = imageBlocks.length > 0
      ? [...imageBlocks, { type: 'text', text: userPromptText }]
      : userPromptText;

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const message = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 8000,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userContent }]
    });

    const responseText = message.content[0].text.trim();
    const stopReason = message.stop_reason;
    let reportData;
    try {
      // Try to extract JSON even if Claude added extra text — find first { and matching last }
      let jsonStr = responseText
        .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

      // If still not parsing, try to find the JSON object boundaries
      const firstBrace = jsonStr.indexOf('{');
      const lastBrace = jsonStr.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        jsonStr = jsonStr.slice(firstBrace, lastBrace + 1);
      }

      reportData = JSON.parse(jsonStr);
    } catch (e) {
      console.error('JSON parse error:', e.message);
      console.error('Stop reason:', stopReason);
      console.error('Response length:', responseText.length);
      console.error('Response preview:', responseText.slice(0, 300));
      console.error('Response end:', responseText.slice(-300));

      const truncated = stopReason === 'max_tokens';
      const errMsg = truncated
        ? 'The AI response was too long and got cut off. Try a shorter incident description, or contact support to increase the limit.'
        : 'The AI returned an unexpected format. This usually clears on a retry — please try again.';
      return res.status(500).json({ error: errMsg, detail: e.message });
    }

    reportData.refId = generateRefId();
    reportData.date = new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' });
    reportData.industry = reportData.detectedIndustry || 'Unknown';
    reportData.type = incidentTypeStr;
    reportData.country = reportData.detectedCountry || 'Unknown';
    reportData.state = reportData.detectedState || '';
    reportData.location = location || 'Not specified';
    reportData.description = description;

    res.json({ success: true, report: reportData });

  } catch (error) {
    console.error('Analysis error:', error);
    res.status(500).json({ error: 'Analysis failed. Please try again.', detail: error.message });
  }
});

// ============ REFINE ENDPOINT ============
app.post('/api/refine', async (req, res) => {
  try {
    const { currentReport, instruction } = req.body;
    if (!currentReport || !instruction || !instruction.trim()) {
      return res.status(400).json({ error: 'Current report and instruction are required.' });
    }

    // Strip metadata fields that the AI shouldn't rewrite
    const reportForAI = { ...currentReport };
    delete reportForAI.refId;
    delete reportForAI.date;
    delete reportForAI.description;  // raw input — keep, don't let AI change
    delete reportForAI.location;

    const refinePrompt = `You are refining an existing HSE investigation draft. Apply the user's instruction below and return the updated report.

CURRENT DRAFT (JSON):
${JSON.stringify(reportForAI, null, 2)}

USER INSTRUCTION:
"${instruction}"

RULES:
1. Apply ONLY the user's requested change. Keep everything else identical.
2. Maintain the same JSON structure (all the same field names).
3. Continue tagging findings with [FACT], [INFERENCE], [PATTERN].
4. NEVER manufacture facts. If the user asks you to add a fact not provided in their instruction, only do so if they have given you that fact directly. Otherwise, decline politely in the changesSummary.
5. Never use "root cause" terminology.
6. Never blame individuals by name.
7. If the user's instruction conflicts with rules above, explain politely in changesSummary and do not make the harmful change.

Return ONLY valid JSON in this exact shape (no markdown, no backticks):
{
  "updatedReport": { ...full updated report with the same fields as the current draft... },
  "changesSummary": "One short sentence describing exactly what was changed. If you declined to make a requested change, explain why here."
}`;

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const message = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 8000,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: refinePrompt }]
    });

    const responseText = message.content[0].text.trim();
    const stopReason = message.stop_reason;
    let parsed;
    try {
      let jsonStr = responseText
        .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
      const firstBrace = jsonStr.indexOf('{');
      const lastBrace = jsonStr.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        jsonStr = jsonStr.slice(firstBrace, lastBrace + 1);
      }
      parsed = JSON.parse(jsonStr);
    } catch (e) {
      console.error('Refine parse error:', e.message, 'Stop:', stopReason);
      const truncated = stopReason === 'max_tokens';
      return res.status(500).json({
        error: truncated
          ? 'Response was cut off. Try a more focused instruction.'
          : 'Could not parse the AI response. Please try rephrasing your instruction.'
      });
    }

    // Re-attach preserved metadata
    const updated = { ...parsed.updatedReport };
    updated.refId = currentReport.refId;
    updated.date = currentReport.date;
    updated.description = currentReport.description;
    updated.location = currentReport.location;
    updated.industry = updated.detectedIndustry || currentReport.industry;
    updated.country = updated.detectedCountry || currentReport.country;
    updated.state = updated.detectedState || currentReport.state;
    updated.type = currentReport.type;

    res.json({
      success: true,
      report: updated,
      changesSummary: parsed.changesSummary || 'Report updated.'
    });

  } catch (error) {
    console.error('Refine error:', error);
    res.status(500).json({ error: 'Refinement failed. Please try again.', detail: error.message });
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
          bP(r.cleanDescription || r.description || ''),
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
