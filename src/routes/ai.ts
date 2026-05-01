import { Router, Response } from 'express'
import multer from 'multer'
import OpenAI, { toFile } from 'openai'
import { AuthRequest } from '../types'
import { verifyToken } from '../middleware/auth'

const router = Router()
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 } // 25 MB maks
})

function getOpenAI(): OpenAI {
  const key = process.env.OPENAI_API_KEY
  if (!key) throw new Error('OPENAI_API_KEY er ikke sat')
  return new OpenAI({ apiKey: key })
}

// --- Prompts ---

function analyzePrompt(transcription: string): string {
  return `Du er en produktivitetsassistent. Analyser denne transskription og returner JSON med:
1. En kort sigende titel (max 6 ord)
2. Et kort resume (2-3 sætninger)
3. En liste af konkrete opgaver/handlinger

Returner KUN dette JSON format:
{
    "title": "...",
    "summary": "...",
    "tasks": ["opgave 1", "opgave 2"]
}

Transskription: ${transcription}`
}

function visionPrompt(transcription: string): string {
  return `Du er en produktivitetsassistent. Du får et billede og en transskription fra en talenotat.

Analyser begge og returner JSON med:
1. En kort sigende titel (max 6 ord)
2. Et kort resume der kombinerer hvad der ses på billedet og hvad der siges (2-3 sætninger)
3. En liste af konkrete opgaver/handlinger baseret på begge inputs
4. En præcis transskription af AL tekst der er synlig i billedet (bevar original formatering og rækkefølge)

Returner KUN dette JSON format:
{
    "title": "...",
    "summary": "...",
    "tasks": ["opgave 1", "opgave 2"],
    "imageTranscription": "al tekst fra billedet her, eller null hvis ingen tekst"
}

Transskription: ${transcription}`
}

function parseVoiceCommandPrompt(
  contactList: string,
  taskList: string
): string {
  return `Du er en assistent der parser stemmekommandoer til at sende noter via email.
Tilgængelige kontakter: ${contactList}
Tilgængelige opgaver:
${taskList}

Returner KUN JSON med disse felter:
- contactNames: liste af kontaktnavne at sende til
- includeResume: om resumé skal med (default true)
- includeTranscription: om transskription skal med
- taskIndices: liste af opgavenumre (1-baseret) der skal med
- includeAllTasks: om alle opgaver skal med
- includeImage: om billede skal vedhæftes
- includeImageText: om tekst fra billede skal med

Eksempel: "send resumé og opgave 1 og 3 til Michael"
Svar: {"contactNames":["Michael"],"includeResume":true,"includeTranscription":false,"taskIndices":[1,3],"includeAllTasks":false,"includeImage":false,"includeImageText":false}`
}

function parseAlarmPrompt(now: string): string {
  return `Du er en assistent der udtrækker dato og tid fra dansk tekst. Returner KUN en ISO datetime string på formatet "2025-05-02T14:00:00", eller ordet null hvis du ikke kan tolke datoen. I dag er: ${now}`
}

// --- Endpoints ---

// POST /ai/transcribe
// Multipart: field "file" (audio/m4a eller audio/*)
router.post('/transcribe', verifyToken, upload.single('file'), async (req: AuthRequest, res: Response) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'Ingen lydfil vedhæftet' })
      return
    }
    const openai = getOpenAI()
    const audioFile = await toFile(req.file.buffer, req.file.originalname ?? 'audio.m4a', {
      type: req.file.mimetype ?? 'audio/m4a'
    })
    const transcription = await openai.audio.transcriptions.create({
      file: audioFile,
      model: 'whisper-1',
      language: 'da'
    })
    res.json({ text: transcription.text })
  } catch (err) {
    console.error('ai/transcribe fejl:', err)
    res.status(500).json({ error: 'Transskription fejlede' })
  }
})

// POST /ai/analyze
// Body: { transcription: string }
// Returns: { title, summary, tasks }
router.post('/analyze', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const { transcription } = req.body
    if (!transcription || typeof transcription !== 'string') {
      res.status(400).json({ error: 'Mangler transskription i body' })
      return
    }
    const openai = getOpenAI()
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: analyzePrompt(transcription) }],
      max_tokens: 800,
      response_format: { type: 'json_object' }
    })
    const content = completion.choices[0].message.content ?? '{}'
    res.json(JSON.parse(content))
  } catch (err) {
    console.error('ai/analyze fejl:', err)
    res.status(500).json({ error: 'Analyse fejlede' })
  }
})

// POST /ai/vision
// Multipart: field "image" (image/*), field "transcription" (text)
// Returns: { title, summary, tasks, imageTranscription }
router.post('/vision', verifyToken, upload.single('image'), async (req: AuthRequest, res: Response) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'Intet billede vedhæftet' })
      return
    }
    const transcription = (req.body.transcription as string) ?? ''
    const openai = getOpenAI()
    const base64 = req.file.buffer.toString('base64')
    const mimeType = req.file.mimetype ?? 'image/jpeg'

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: visionPrompt(transcription) },
          {
            type: 'image_url',
            image_url: {
              url: `data:${mimeType};base64,${base64}`,
              detail: 'low'
            }
          }
        ]
      }],
      max_tokens: 1500,
      response_format: { type: 'json_object' }
    })
    const content = completion.choices[0].message.content ?? '{}'
    res.json(JSON.parse(content))
  } catch (err) {
    console.error('ai/vision fejl:', err)
    res.status(500).json({ error: 'Vision-analyse fejlede' })
  }
})

// POST /ai/parse-command
// Body: { spokenText, contactNames, tasks }
// Returns: VoiceCommandResult JSON
router.post('/parse-command', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const { spokenText, contactNames = [], tasks = [] } = req.body
    if (!spokenText) {
      res.status(400).json({ error: 'Mangler spokenText' })
      return
    }
    const openai = getOpenAI()
    const taskList = (tasks as string[]).map((t, i) => `${i + 1}. ${t}`).join('\n')
    const contactList = (contactNames as string[]).join(', ')

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: parseVoiceCommandPrompt(contactList, taskList) },
        { role: 'user', content: spokenText }
      ],
      max_tokens: 200,
      response_format: { type: 'json_object' }
    })
    const content = completion.choices[0].message.content ?? '{}'
    res.json(JSON.parse(content))
  } catch (err) {
    console.error('ai/parse-command fejl:', err)
    res.status(500).json({ error: 'Kommandoparsing fejlede' })
  }
})

// POST /ai/parse-alarm
// Body: { spokenText }
// Returns: { epochMs: number | null }
router.post('/parse-alarm', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const { spokenText } = req.body
    if (!spokenText) {
      res.status(400).json({ error: 'Mangler spokenText' })
      return
    }
    const now = new Date().toLocaleString('da-DK', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit'
    })
    const openai = getOpenAI()
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: parseAlarmPrompt(now) },
        { role: 'user', content: `Tekst: "${spokenText}"` }
      ],
      max_tokens: 50
    })
    const content = (completion.choices[0].message.content ?? '').trim()
    if (content === 'null' || !content) {
      res.json({ epochMs: null })
      return
    }
    const date = new Date(content)
    res.json({ epochMs: isNaN(date.getTime()) ? null : date.getTime() })
  } catch (err) {
    console.error('ai/parse-alarm fejl:', err)
    res.status(500).json({ error: 'Alarmtolkning fejlede' })
  }
})

export default router
