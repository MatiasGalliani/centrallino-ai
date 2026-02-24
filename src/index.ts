import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import dotenv from 'dotenv';
import type { WebSocket, RawData } from 'ws';
import { Client } from 'pg';
import cors from '@fastify/cors'
import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'
import { Readable, PassThrough } from 'node:stream';
import OpenAI from 'openai';
import twilio from 'twilio'

dotenv.config();

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

interface TwilioStartEvent {
    event: 'start';
    start: {
        accountSid: string;
        callSid: string;
        streamSid: string;
        tracks: string[];
    };
}

interface TwilioMediaEvent {
    event: 'media';
    sequenceNumber: string;
    media: {
        track: 'inbound' | 'outbound';
        chunk: string;
        payload: string;
    };
    streamSid: string;
}

interface TwilioStopEvent {
    event: 'stop';
    stop: {
        accountSid: string;
        callSid: string;
        streamSid: string;
    };
}

interface CallSession {
    callSid: string;
    streamSid: string;
    socket: WebSocket;
    campaignPrompt: string;
    campaignVoiceId: string;
    isProcessing: boolean;
    conversationHistory: Array<{
        role: 'user' | 'assistant';
        content: string;
    }>;
    audioBuffer: Buffer[];
}

const activeCalls = new Map<string, CallSession>();

async function getCampaignById(id: number) {
    const client = new Client({
        host: process.env.DB_HOST || 'localhost',
        port: Number(process.env.DB_PORT) || 5432,
        database: process.env.DB_NAME || 'voiceai',
        user: process.env.DB_USER || 'postgres',
        password: process.env.DB_PASSWORD || '',
    });
    try {
        await client.connect();
        const result = await client.query(
            `SELECT id, campaign_prompt, voice_id FROM campaigns WHERE id = $1`,
            [id]
        );
        return result.rows[0] ?? null;
    } finally {
        await client.end();
    }
}

async function sendGreeting(session: CallSession) {
    try {
        const gptResponse = await openaiClient.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
                { role: 'system', content: session.campaignPrompt },
                { role: 'user', content: '[START_CALL] La llamada acaba de conectar. Preséntate brevemente y saluda al usuario.' },
            ],
        });

        const greetingText = gptResponse.choices[0]?.message?.content ?? 'Ciao, come posso aiutarti?';
        session.conversationHistory.push({ role: 'assistant', content: greetingText });

        console.log('[Greeting]', greetingText);

        const ttsRes = await fetch(
            `https://api.elevenlabs.io/v1/text-to-speech/${session.campaignVoiceId}`,
            {
                method: 'POST',
                headers: {
                    'xi-api-key': process.env.ELEVENLABS_API_KEY!,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    text: greetingText,
                    model_id: 'eleven_multilingual_v2',
                    output_format: 'mp3_44100_128',
                }),
            }
        );

        if (!ttsRes.ok) {
            const errText = await ttsRes.text();
            throw new Error(`ElevenLabs greeting error ${ttsRes.status}: ${errText}`);
        }

        const mp3Buffer = Buffer.from(await ttsRes.arrayBuffer());
        const mulawAudio = await mp3ToMulaw(mp3Buffer);

        session.socket.send(JSON.stringify({
            event: 'media',
            streamSid: session.streamSid,
            media: { payload: mulawAudio.toString('base64') },
        }));

    } catch (err) {
        console.error('[Greeting error]', err);
    }
}

async function processAudioPipeline(session: CallSession, audioBuffer: Buffer) {
    if (session.isProcessing) return;
    session.isProcessing = true;

    try {
        // 1. mulaw 8000hz → WAV para Whisper
        const wavBuffer = await mulawToWav(audioBuffer);

        // 2. Transcribir con Whisper
        const transcription = await openaiClient.audio.transcriptions.create({
            file: new File([new Uint8Array(wavBuffer)], 'audio.wav', { type: 'audio/wav' }),
            model: 'whisper-1',
        });

        const userText = transcription.text.trim();
        if (!userText) {
            session.isProcessing = false;
            return;
        }

        console.log('[Whisper]', userText);

        // 3. Historial + GPT
        session.conversationHistory.push({ role: 'user', content: userText });

        const gptResponse = await openaiClient.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
                { role: 'system', content: session.campaignPrompt },
                ...session.conversationHistory,
            ],
        });

        const assistantText = gptResponse.choices[0]?.message?.content ?? '';
        session.conversationHistory.push({ role: 'assistant', content: assistantText });

        console.log('[GPT]', assistantText);

        // 4. TTS con ElevenLabs
        const ttsRes = await fetch(
            `https://api.elevenlabs.io/v1/text-to-speech/${session.campaignVoiceId}`,
            {
                method: 'POST',
                headers: {
                    'xi-api-key': process.env.ELEVENLABS_API_KEY!,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    text: assistantText,
                    model_id: 'eleven_multilingual_v2',
                    output_format: 'mp3_44100_128',
                }),
            }
        );

        if (!ttsRes.ok) {
            const errText = await ttsRes.text();
            throw new Error(`ElevenLabs TTS error ${ttsRes.status}: ${errText}`);
        }

        const mp3Buffer = Buffer.from(await ttsRes.arrayBuffer());

        // 5. MP3 → mulaw 8000hz (formato Twilio)
        const mulawAudio = await mp3ToMulaw(mp3Buffer);

        // 6. Enviar audio de vuelta al llamante via WebSocket
        session.socket.send(JSON.stringify({
            event: 'media',
            streamSid: session.streamSid,
            media: { payload: mulawAudio.toString('base64') },
        }));

    } catch (err) {
        console.error('[Pipeline error]', err);
    } finally {
        session.isProcessing = false;
    }
}

async function mulawToWav(mulawBuffer: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] =  [];
        const readable = new Readable();
        readable.push(mulawBuffer);
        readable.push(null);

        const passThrough = new PassThrough();
        passThrough.on('data', (chunk) => chunks.push(chunk));
        passThrough.on('end', () => resolve(Buffer.concat(chunks)));
        passThrough.on('error', reject);

        ffmpeg(readable)
            .inputFormat('mulaw')
            .inputOptions(['-ar 8000', '-ac 1'])
            .outputFormat('wav')
            .on('error', reject)
            .pipe(passThrough);
    });
}

async function mp3ToMulaw(mp3Buffer: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        const readable = new Readable();
        readable.push(mp3Buffer);
        readable.push(null);

        const passThrough = new PassThrough();
        passThrough.on('data', (chunk) => chunks.push(chunk));
        passThrough.on('end', () => resolve(Buffer.concat(chunks)));
        passThrough.on('error', reject);

        ffmpeg(readable)
            .outputFormat('mulaw')
            .outputOptions(['-ar 8000', '-ac 1'])
            .on('error', reject)
            .pipe(passThrough);
    })
}

async function getCampaigns() {
    const client = new Client({
        host: process.env.DB_HOST || "localhost",
        port: Number(process.env.DB_PORT) || 5432,
        database: process.env.DB_NAME || "voiceai",
        user: process.env.DB_USER || 'postgres',
        password: process.env.DB_PASSWORD || '',
    });

    try {
        await client.connect();
        const result = await client.query(
            `SELECT id, slug, name, description, leads, calls, qualified,
            campaign_prompt, voice_id, initial_delay, max_retries,
            retry_interval, webhook_url, calendar_connected
            FROM campaigns
            ORDER BY created_at DESC`
        );
        return result.rows;
    } finally {
        await client.end();
    }
}

async function createCampaign(campaign: {
    slug: string;
    name: string;
    description?: string;
    campaign_prompt?: string;
    voice_id?: string;
    initial_delay?: number;
    max_retries?: number;
    retry_interval?: number;
    webhook_url?: string;
    calendar_connected?: boolean;
}) {
    const client = new Client({
        host: process.env.DB_HOST || 'localhost',
        port: Number(process.env.DB_PORT) || 5432,
        database: process.env.DB_NAME || 'voiceai',
        user: process.env.DB_USER || 'postgres',
        password: process.env.DB_PASSWORD || '',
    });

    try {
        await client.connect();
        const result = await client.query(
            `INSERT INTO campaigns (slug, name, description, campaign_prompt, voice_id, initial_delay, max_retries, retry_interval, webhook_url, calendar_connected)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             RETURNING id, slug, name, description, leads, calls, qualified`,
             [
                campaign.slug,
                campaign.name,
                campaign.description || null,
                campaign.campaign_prompt || null,
                campaign.voice_id || null,
                campaign.initial_delay || 0,
                campaign.max_retries || 0,
                campaign.retry_interval || 0,
                campaign.webhook_url || null,
                campaign.calendar_connected || false
             ]
        );
        return result.rows[0];
    } finally {
        await client.end()
    }
}

async function deleteCampaign(id: number) {
    const client = new Client({
        host: process.env.DB_HOST || 'localhost',
        port: Number(process.env.DB_PORT) || 5432,
        database: process.env.DB_NAME || 'voiceai',
        user: process.env.DB_USER || 'postgres',
        password: process.env.DB_PASSWORD || '',
    });

    try {
        await client.connect();
        const result = await client.query(
            'DELETE FROM campaigns WHERE id = $1 RETURNING id',
            [id]
        );
        
        // Si no se eliminó nada, la campaña no existe
        if (result.rows.length === 0) {
            return null; // null = no encontrada
        }
        
        return result.rows[0].id; // Retorna el id eliminado
    } finally {
        await client.end();
    }
}

async function updateCampaign(id: number, updates: {
    name?: string;
    description?: string;
    campaign_prompt?: string;
    voice_id?: string;
    initial_delay?: number;
    max_retries?: number;
    retry_interval?: number;
    webhook_url?: string;
    calendar_connected?: boolean;
}) {
    const client = new Client({
        host: process.env.DB_HOST || 'localhost',
        port: Number(process.env.DB_PORT) || 5432,
        database: process.env.DB_NAME || 'voiceai',
        user: process.env.DB_USER || 'postgres',
        password: process.env.DB_PASSWORD || '',
    });

    try {
        await client.connect();
        
        // Construir dinámicamente el UPDATE solo con los campos que vienen
        const fields: string[] = [];
        const values: any[] = [];
        let paramIndex = 1;

        if (updates.name !== undefined) {
            fields.push(`name = $${paramIndex++}`);
            values.push(updates.name);
        }
        if (updates.description !== undefined) {
            fields.push(`description = $${paramIndex++}`);
            values.push(updates.description);
        }
        if (updates.campaign_prompt !== undefined) {
            fields.push(`campaign_prompt = $${paramIndex++}`);
            values.push(updates.campaign_prompt);
        }
        if (updates.voice_id !== undefined) {
            fields.push(`voice_id = $${paramIndex++}`);
            values.push(updates.voice_id);
        }
        if (updates.initial_delay !== undefined) {
            fields.push(`initial_delay = $${paramIndex++}`);
            values.push(updates.initial_delay);
        }
        if (updates.max_retries !== undefined) {
            fields.push(`max_retries = $${paramIndex++}`);
            values.push(updates.max_retries);
        }
        if (updates.retry_interval !== undefined) {
            fields.push(`retry_interval = $${paramIndex++}`);
            values.push(updates.retry_interval);
        }
        if (updates.webhook_url !== undefined) {
            fields.push(`webhook_url = $${paramIndex++}`);
            values.push(updates.webhook_url);
        }
        if (updates.calendar_connected !== undefined) {
            fields.push(`calendar_connected = $${paramIndex++}`);
            values.push(updates.calendar_connected);
        }

        if (fields.length === 0) {
            return null; // No hay nada que actualizar
        }

        // Agregar updated_at automáticamente
        fields.push(`updated_at = CURRENT_TIMESTAMP`);
        values.push(id);

        const query = `UPDATE campaigns SET ${fields.join(', ')} WHERE id = $${paramIndex} RETURNING id, slug, name, description, campaign_prompt, voice_id, initial_delay, max_retries, retry_interval, webhook_url, calendar_connected, leads, calls, qualified`;
        
        const result = await client.query(query, values);
        
        if (result.rows.length === 0) {
            return null; // Campaña no encontrada
        }
        
        return result.rows[0];
    } finally {
        await client.end();
    }
}

const fastify = Fastify({ logger:true });

fastify.register(cors, {
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'DELETE', 'PATCH']
});

fastify.register(websocket);

const PORT = process.env.PORT || 3000

// Route for twilio
fastify.get('/', async () => {
    return { status: 'Centralino AI Running '};
});

fastify.get("/campaigns", async(request, reply) => {
    try {
        const campaigns = await getCampaigns();
        return { campaigns };
    } catch (error) {
        reply.code(500);
        return { error: "Failed to fetch campaigns" };
    }
});

fastify.get("/api/voices", async (request, reply) => {
    try {
        const res = await fetch("https://api.elevenlabs.io/v1/voices", {
            headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY! },
        });
        if (!res.ok) throw new Error("ElevenLabs API error");
        const data = await res.json();
        return {
            voices: data.voices.map((v: any) => ({
                id: v.voice_id,
                name: v.name,
                category: v.category || "unknown",
                description: v.labels?.description || v.category || "",
            })),
        };
    } catch (e: any) {
        reply.code(502);
        return { error: "Failed to fetch voices", details: e.message };
    }
});

fastify.get("/api/voices/:voiceId/preview", async (request, reply) => {
    const { voiceId } = request.params as { voiceId: string };
    const text = (request.query as { text?: string }).text || "Hello, this is a voice sample. How does it sound?";

    try {
        const apiKey = process.env.ELEVENLABS_API_KEY;
        if (!apiKey) {
            reply.code(502);
            return { error: "Server misconfiguration", details: "Missing ELEVENLABS_API_KEY" };
        }
        const res = await fetch(
            `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
            {
                method: "POST",
                headers: {
                    "xi-api-key": apiKey,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    text,
                    model_id: "eleven_multilingual_v2",
                    output_format: "mp3_44100_128",
                }),
            }
        );
        if (!res.ok) {
            const errText = await res.text();
            console.error("[GET /api/voices/:voiceId/preview] ElevenLabs TTS error:", res.status, errText);
            reply.code(502);
            return { error: "Failed to generate preview", details: `${res.status} ${errText}` };
        }
        const audioBuffer = await res.arrayBuffer();

        reply
            .header("Content-Type", "audio/mpeg")
            .header("Cache-Control", "public, max-age=3600")
            .send(Buffer.from(audioBuffer));
    } catch (e: any) {
        console.error("[GET /api/voices/:voiceId/preview]", e);
        reply.code(502);
        return { error: "Failed to generate preview", details: e.message };
    }
});

fastify.post("/campaigns", async (request, reply) => {
    try {
        const campaign = await createCampaign(request.body as any);
        reply.code(201);
        return { campaign };
    } catch (error: any) {
        console.error('Error creating campaign:', error); // ← Agregar esto
        if (error.code === '23505') { // Unique violation
            reply.code(409);
            return { error: 'Campaign with this slug already exists' };
        }
        reply.code(500);
        return { error: 'Failed to create campaign', details: error.message }; // ← Y esto para ver el mensaje
    }
});

fastify.delete("/campaigns/:id", async (request, reply) => {
    try {
        const id = Number((request.params as any).id);
        
        if (isNaN(id)) {
            reply.code(400);
            return { error: 'Invalid campaign ID' };
        }
        
        const deletedId = await deleteCampaign(id);
        
        if (deletedId === null) {
            reply.code(404);
            return { error: 'Campaign not found' };
        }
        
        reply.code(200);
        return { message: 'Campaign deleted successfully', id: deletedId };
    } catch (error: any) {
        console.error('Error deleting campaign:', error);
        reply.code(500);
        return { error: 'Failed to delete campaign', details: error.message };
    }
});

fastify.patch("/campaigns/:id", async (request, reply) => {
    try {
        const id = Number((request.params as any).id);
        
        if (isNaN(id)) {
            reply.code(400);
            return { error: 'Invalid campaign ID' };
        }
        
        const updatedCampaign = await updateCampaign(id, request.body as any);
        
        if (updatedCampaign === null) {
            reply.code(404);
            return { error: 'Campaign not found' };
        }
        
        reply.code(200);
        return { campaign: updatedCampaign };
    } catch (error: any) {
        console.error('Error updating campaign:', error);
        reply.code(500);
        return { error: 'Failed to update campaign', details: error.message };
    }
});

fastify.get('/twiml', async (request, reply) => {
    const { campaignId } = request.query as { campaignId?: string };
    const host = request.headers.host;
    const wsUrl = `wss://${host}/media-stream${campaignId ? `?campaignId=${campaignId}` : ''}`;

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}" />
  </Connect>
</Response>`;

    reply.header('Content-Type', 'text/xml');
    return reply.send(twiml);
});

fastify.post('/calls/outbound', async (request, reply) => {
    const { to, campaignId } = request.body as { to: string; campaignId: number };

    if (!to || !campaignId) {
        reply.code(400);
        return { error: 'Missing required fields: to, campaignId' };
    }

    try {
        const campaign = await getCampaignById(campaignId);
        if (!campaign) {
            reply.code(404);
            return { error: 'Campaign not found' };
        }

        const twimlUrl = `${process.env.SERVER_URL}/twiml?campaignId=${campaignId}`;

        const call = await twilioClient.calls.create({
            to,
            from: process.env.TWILIO_PHONE_NUMBER!,
            url: twimlUrl,
        });

        console.log(`[Outbound] Call initiated to ${to}, SID: ${call.sid}`);
        return { callSid: call.sid, status: call.status };
    } catch (err: any) {
        console.error('[Outbound] Error:', err);
        reply.code(500);
        return { error: 'Failed to initiate call', details: err.message };
    }
});

// Route of the Websocket where twilio will send the audio real time
fastify.register(async (fastify) => {
    fastify.get('/media-stream', { websocket: true }, (connection: WebSocket, req) => {
        console.log('Client connected via Websocket');

        connection.on('message', async (message: RawData) => {
            const data = JSON.parse(message.toString());

            //Twilio sends different type of events
            switch (data.event) {

                case 'start':
                    const startData = data as TwilioStartEvent;
                    console.log('Call has started:', startData.start.callSid);

                    const campaignIdParam = (req.query as any).campaignId;
                    let campaignPrompt = 'You are a helpful assistant.';
                    let campaignVoiceId = process.env.ELEVENLABS_VOICE_ID || '';

                    if (campaignIdParam) {
                        try {
                            const campaign = await getCampaignById(Number(campaignIdParam));
                            if (campaign?.campaign_prompt) campaignPrompt = campaign.campaign_prompt;
                            if (campaign?.voice_id) campaignVoiceId = campaign.voice_id;
                        } catch (e) {
                            console.error('[WS start] Error fetching campaign:', e);
                        }
                    }

                    const newSession: CallSession = {
                        callSid: startData.start.callSid,
                        streamSid: startData.start.streamSid,
                        socket: connection,
                        campaignPrompt,
                        campaignVoiceId,
                        isProcessing: false,
                        conversationHistory: [],
                        audioBuffer: [],
                    };

                    activeCalls.set(startData.start.streamSid, newSession);
                    sendGreeting(newSession);
                    break;

                case 'media':
                    const mediaData = data as TwilioMediaEvent;

                    // Ignorar audio outbound (la propia voz de la IA)
                    if (mediaData.media.track !== 'inbound') break;

                    const session = activeCalls.get(mediaData.streamSid);

                    if (!session) {
                        console.log('Received media for unknown stream:', mediaData.streamSid);
                        break;
                    }

                    const audioChunk = Buffer.from(mediaData.media.payload, 'base64');
                    session.audioBuffer.push(audioChunk);

                    // Cada chunk es ~20ms. 150 chunks = ~3 segundos de audio del usuario
                    if (session.audioBuffer.length >= 150) {
                        const combinedAudio = Buffer.concat(session.audioBuffer);
                        session.audioBuffer = [];
                        processAudioPipeline(session, combinedAudio);
                    }
                    break;

                case 'stop':
                    const stopData = data as TwilioStopEvent
                    console.log('Call has ended', stopData.stop.callSid);

                    activeCalls.delete(stopData.stop.streamSid);
                    break;
            }
        });
    });
});

fastify.listen({ port: Number(PORT), host: '0.0.0.0' }, (err) => {
    if (err) {
        console.error(err);
        process.exit(1);
    }
    console.log(`Server listening on port:${PORT}`);
})
