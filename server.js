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
// This is the brain of Safehub — it tells Claude how to think
// like an experienced HSE investigator. Your domain expertise lives here.
const SYSTEM_PROMPT = `You are an expert HSE (Health, Safety and Environment) 
investigator with 20+ years of experience in mining, construction, rail, 
manufacturing, oil & gas, and industrial operations across Australia.

You are deeply familiar with:
- ICAM (Incident Cause Analysis Method) — the Australian standard for 
  incident investigation used by Tier 1 miners and rail operators
- 5 Whys root cause analysis
- Fishbone (Ishikawa) cause-and-effect diagrams
- Bow-Tie analysis for critical risk events
- Hierarchy of Controls (Elimination → Substitution → Engineering → 
  Administrative → PPE)
- The Work Health and Safety Act 2011 (WHS Act) and associated regulations
- Safe Work Australia codes of practice
- State-specific mining regulations (NSW, QLD, WA)
- AS/NZS standards relevant to workplace safety
- Notifiable incident obligations under the WHS Act
- Critical risk management frameworks used in mining and construction

Your investigations are:
- Thorough and systematic — you never jump to conclusions
- Evidence-based — you only state what can be reasonably inferred
- Blame-aware — you focus on systemic and organisational causes, 
  not blaming individuals
- Regulatory-aligned — you reference applicable legislation and standards
- Actionable — your corrective actions are specific, achievable, and ranked

You always apply the ICAM framework which categorises causes into:
1. Absent or Failed Defences
2. Individual/Team Actions
3. Task/Environmental Conditions  
4. Organisational Factors (the deepest, most systemic causes)

You understand that most incidents have multiple contributing factors 
and that the root cause is almost always organisational — a missing 
system, schedule, procedure, or oversight mechanism.`;

// ============ ANALYSE INCIDENT ENDPOINT ============
app.post('/api/analyse', upload.array('files', 10), async (req, res) => {
  try {
    const { description, industry, incidentType, location, date } = req.body;

    if (!description || !industry || !incidentType) {
      return res.status(400).json({ 
        error: 'Description, industry and incident type are required.' 
      });
    }

    // Process any uploaded files
    let fileContext = '';
    if (req.files && req.files.length > 0) {
      fileContext = '\n\n--- UPLOADED DOCUMENTS ---\n';
      for (const file of req.files) {
        fileContext += `\nDocument: ${file.originalname} (${file.mimetype})\n`;
        
        try {
          if (file.mimetype === 'application/pdf') {
            const pdfParse = require('pdf-parse');
            const data = await pdfParse(file.buffer);
            fileContext += `Content:\n${data.text.slice(0, 3000)}\n`;
          } else if (
            file.mimetype === 'application/vnd.openxmlformats-officedocument' +
            '.spreadsheetml.sheet' || 
            file.mimetype === 'application/vnd.ms-excel'
          ) {
            const XLSX = require('xlsx');
            const workbook = XLSX.read(file.buffer, { type: 'buffer' });
            const sheet = workbook.Sheets[workbook.SheetNames[0]];
            const text = XLSX.utils.sheet_to_csv(sheet);
            fileContext += `Content (CSV format):\n${text.slice(0, 3000)}\n`;
          } else if (
            file.mimetype === 'application/vnd.openxmlformats-officedocument' +
            '.wordprocessingml.document'
          ) {
            const mammoth = require('mammoth');
            const result = await mammoth.extractRawText({ 
              buffer: file.buffer 
            });
            fileContext += `Content:\n${result.value.slice(0, 3000)}\n`;
          } else if (file.mimetype.startsWith('text/')) {
            fileContext += `Content:\n${
              file.buffer.toString('utf8').slice(0, 3000)
            }\n`;
          } else {
            fileContext += `[File uploaded but content type not extractable 
            — ${file.mimetype}]\n`;
          }
        } catch (fileErr) {
          fileContext += `[Could not extract text from this file]\n`;
        }
      }
      fileContext += '\n--- END OF UPLOADED DOCUMENTS ---\n';
    }

    // Build the user prompt
    const userPrompt = `Please conduct a thorough HSE investigation for 
the following incident and return your analysis as a JSON object.

INCIDENT DETAILS:
Industry: ${industry}
Incident Type: ${incidentType}
${location ? `Location: ${location}` : ''}
${date ? `Date: ${date}` : ''}

INCIDENT DESCRIPTION:
${description}
${fileContext}

Return ONLY a valid JSON object with exactly this structure 
(no markdown, no backticks, just raw JSON):

{
  "executiveSummary": "2-3 sentence summary of the incident, 
    key findings, and number of corrective actions recommended",
  
  "incidentSequence": "Chronological reconstruction of events 
    leading to the incident. 3-5 sentences.",
  
  "immediateCauses": [
    "First immediate cause — specific to this incident",
    "Second immediate cause",
    "Third immediate cause (if applicable)"
  ],
  
  "contributingFactors": [
    "First contributing factor — systemic or environmental",
    "Second contributing factor",
    "Third contributing factor",
    "Fourth contributing factor (if applicable)"
  ],
  
  "fiveWhys": [
    {
      "why": "Why did the incident occur?",
      "because": "Direct answer specific to this incident"
    },
    {
      "why": "Why did that happen?",
      "because": "One level deeper — procedural or task level"
    },
    {
      "why": "Why did that condition exist?",
      "because": "Process or system level"
    },
    {
      "why": "Why was that process gap present?",
      "because": "Organisational level"
    },
    {
      "why": "Why has this not been addressed organisationally?",
      "because": "Root cause — the deepest systemic finding"
    }
  ],
  
  "icam": {
    "absentFailedDefences": [
      "Specific defence that was absent or failed"
    ],
    "individualTeamActions": [
      "Specific individual or team action that contributed"
    ],
    "taskEnvironmentalConditions": [
      "Specific task or environmental condition"
    ],
    "organisationalFactors": [
      "Specific organisational factor — deepest causes"
    ]
  },
  
  "rootCauses": [
    {
      "title": "Short title for root cause 1",
      "detail": "Full explanation of this root cause and why it 
        is systemic"
    },
    {
      "title": "Short title for root cause 2",
      "detail": "Full explanation"
    }
  ],
  
  "correctiveActions": [
    {
      "tier": "Elimination",
      "action": "Specific action to eliminate this hazard",
      "owner": "Role responsible (e.g. Engineering Manager)",
      "due": "Timeframe (e.g. 90 days)"
    },
    {
      "tier": "Engineering",
      "action": "Engineering control specific to this incident",
      "owner": "Role responsible",
      "due": "Timeframe"
    },
    {
      "tier": "Administrative",
      "action": "Procedure or training update",
      "owner": "Role responsible",
      "due": "Timeframe"
    },
    {
      "tier": "Administrative",
      "action": "Second administrative control",
      "owner": "Role responsible",
      "due": "Timeframe"
    },
    {
      "tier": "PPE",
      "action": "PPE requirement specific to this incident",
      "owner": "Role responsible",
      "due": "Timeframe"
    }
  ],
  
  "lessonsLearned": [
    "Specific lesson 1 — cross-site applicable",
    "Specific lesson 2",
    "Specific lesson 3"
  ],
  
  "regulatoryNotes": "Specific WHS Act sections, regulations, 
    codes of practice, and Australian Standards relevant to 
    this incident and industry. Include notifiable incident 
    obligations if applicable."
}`;

    // Call Claude API
    const client = new Anthropic({ 
      apiKey: process.env.ANTHROPIC_API_KEY 
    });

    const message = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 4000,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }]
    });

    // Parse the JSON response
    const responseText = message.content[0].text.trim();
    
    let reportData;
    try {
      // Remove any markdown code blocks if present
      const cleaned = responseText
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/```\s*$/i, '')
        .trim();
      reportData = JSON.parse(cleaned);
    } catch (parseErr) {
      console.error('JSON parse error:', parseErr);
      return res.status(500).json({ 
        error: 'Failed to parse AI response. Please try again.' 
      });
    }

    // Add metadata
    reportData.refId = 'SHQ-' + Date.now().toString().slice(-6);
    reportData.date = new Date().toLocaleDateString('en-AU', { 
      day: 'numeric', month: 'long', year: 'numeric' 
    });
    reportData.industry = industry;
    reportData.type = incidentType;
    reportData.location = location || 'Not specified';

    res.json({ success: true, report: reportData });

  } catch (error) {
    console.error('Analysis error:', error);
    res.status(500).json({ 
      error: 'Analysis failed. Please try again.',
      detail: error.message 
    });
  }
});

// Fallback route
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Safehub HQ running on http://localhost:${PORT}`);
});
