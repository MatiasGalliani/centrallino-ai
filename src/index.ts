import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import dotenv from 'dotenv';
import type { WebSocket, RawData } from 'ws';

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
    conversationHistory: Array<{
        role: 'user' | 'assistant';
        content: string;
    }>;
    audioBuffer: Buffer[];
}

dotenv.config();

const activeCalls = new Map<string, CallSession>();

const fastify = Fastify({ logger:true });
fastify.register(websocket);

const PORT = process.env.PORT || 3000

// Route for twilio
fastify.get('/', async () => {
    return { status: 'Centralino AI Running '};
});

// Route of the Websocket where twilio will send the audio real time
fastify.register(async (fastify) => {
    fastify.get('/media-stream', { websocket: true }, (connection: WebSocket, req) => {
        console.log('Client connected via Websocket');

        connection.on('message', (message: RawData) => {
            const data = JSON.parse(message.toString());

            //Twilio sends different type of events
            switch (data.event) {

                case 'start':
                    const startData = data as TwilioStartEvent;
                    console.log('Call has started:', startData.start.callSid);

                    const newSession: CallSession = {
                        callSid: startData.start.callSid,
                        streamSid: startData.start.streamSid,
                        socket: connection,
                        conversationHistory: [],
                        audioBuffer: []
                    };

                    activeCalls.set(startData.start.streamSid, newSession);
                    break;

                case 'media':
                    const mediaData = data as TwilioMediaEvent;
                    const session = activeCalls.get(mediaData.streamSid);

                    if (!session) {
                        console.log('Received media for unknown stream:', mediaData.streamSid);
                        break;
                    }
                    
                    console.log('Received audio chunk for call:', session.callSid);

                    const audioChunk = Buffer.from(mediaData.media.payload, 'base64');
                    session.audioBuffer.push(audioChunk);

                    if (session.audioBuffer.length > 50) {
                        console.log('Enough audio buffered, ready to process');

                        const combinedAudio = Buffer.concat(session.audioBuffer);

                        session.audioBuffer = []; 
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

fastify.listen({ port: Number(PORT), host: '0.0.0' }, (err) => {
    if (err) {
        console.error(err);
        process.exit(1);
    }
    console.log(`Server listening on port:${PORT}`);
})
