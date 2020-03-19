// This code was copied from https://github.com/nteract/enchannel-zmq-backend/blob/master/src/index.ts
// and modified to work with zeromq-beta-6

import { Channels, JupyterMessage } from '@nteract/messaging';
import * as wireProtocol from '@nteract/messaging/lib/wire-protocol';
import * as rxjs from 'rxjs';
import { FromEventTarget } from "rxjs/internal/observable/fromEvent";
import { map, publish, refCount } from 'rxjs/operators';
import { v4 as uuid } from 'uuid';
// tslint:disable-next-line: prettier
import type { Dealer, Subscriber } from 'zeromq';
import { traceError } from '../../../common/logger';

type ChannelName = 'iopub' | 'stdin' | 'shell' | 'control';

// tslint:disable: interface-name no-any
export interface JupyterConnectionInfo {
    version: number;
    iopub_port: number;
    shell_port: number;
    stdin_port: number;
    control_port: number;
    signature_scheme: 'hmac-sha256';
    hb_port: number;
    ip: string;
    key: string;
    transport: 'tcp' | 'ipc';
}

interface HeaderFiller {
    session: string;
    username: string;
}

/**
 * Takes a Jupyter spec connection info object and channel and returns the
 * string for a channel. Abstracts away tcp and ipc connection string
 * formatting
 *
 * @param config  Jupyter connection information
 * @param channel Jupyter channel ("iopub", "shell", "control", "stdin")
 *
 * @returns The connection string
 */
export const formConnectionString = (config: JupyterConnectionInfo, channel: ChannelName) => {
    const portDelimiter = config.transport === 'tcp' ? ':' : '-';
    const port = config[`${channel}_port` as keyof JupyterConnectionInfo];
    if (!port) {
        throw new Error(`Port not found for channel "${channel}"`);
    }
    return `${config.transport}://${config.ip}${portDelimiter}${port}`;
};


/**
 * Creates a socket for the given channel with ZMQ channel type given a config
 *
 * @param channel Jupyter channel ("iopub", "shell", "control", "stdin")
 * @param identity UUID
 * @param config  Jupyter connection information
 *
 * @returns The new Jupyter ZMQ socket
 */
export async function createSubscriber(
    channel: ChannelName,
    config: JupyterConnectionInfo
): Promise<Subscriber> {
    // tslint:disable-next-line: no-require-imports
    const zmq = await require('zeromq') as typeof import('zeromq');
    const socket = new zmq.Subscriber();

    const url = formConnectionString(config, channel);
    await socket.bind(url);
    return socket;
}

/**
 * Creates a socket for the given channel with ZMQ channel type given a config
 *
 * @param channel Jupyter channel ("iopub", "shell", "control", "stdin")
 * @param identity UUID
 * @param config  Jupyter connection information
 *
 * @returns The new Jupyter ZMQ socket
 */
export async function createDealer(
    channel: ChannelName,
    identity: string,
    config: JupyterConnectionInfo
): Promise<Dealer> {
    // tslint:disable-next-line: no-require-imports
    const zmq = await require('zeromq') as typeof import('zeromq');
    const socket = new zmq.Dealer({routingId: identity});

    const url = formConnectionString(config, channel);
    await socket.bind(url);
    return socket;
}


export const getUsername = () =>
    process.env.LOGNAME || process.env.USER || process.env.LNAME || process.env.USERNAME || 'username'; // This is the fallback that the classic notebook uses

/**
 * Sets up the sockets for each of the jupyter channels.
 *
 * @param config Jupyter connection information
 * @param subscription The topic to filter the subscription to the iopub channel on
 * @param identity UUID
 * @param jmp A reference to the JMP Node module
 *
 * @returns Sockets for each Jupyter channel
 */
export const createSockets = async (
    config: JupyterConnectionInfo,
    subscription: string = '',
    identity = uuid()
) => {
    const [shell, control, stdin, iopub] = await Promise.all([
        createDealer('shell', identity, config),
        createDealer('control', identity, config),
        createDealer('stdin', identity, config),
        createSubscriber('iopub', config)
    ]);

    // NOTE: ZMQ PUB/SUB subscription (not an Rx subscription)
    iopub.subscribe(subscription);

    return {
        shell,
        control,
        stdin,
        iopub
    };
};

/**
 * Creates a multiplexed set of channels.
 *
 * @param sockets An object containing associations between channel types and 0MQ sockets
 * @param header The session and username to place in kernel message headers
 * @param jmp A reference to the JMP Node module
 *
 * @returns Creates an Observable for each channel connection that allows us
 * to send and receive messages through the Jupyter protocol.
 */
export const createMainChannelFromSockets = (
    sockets: {
        [name: string]: Subscriber | Dealer;
    },
    header: HeaderFiller = {
        session: uuid(),
        username: getUsername()
    },
): Channels => {
    // The mega subject that encapsulates all the sockets as one multiplexed
    // stream

    const outgoingMessages = rxjs.Subscriber.create<JupyterMessage>(
        async (message) => {
            // There's always a chance that a bad message is sent, we'll ignore it
            // instead of consuming it
            if (!message || !message.channel) {
                console.warn('message sent without a channel', message);
                return;
            }
            const socket = sockets[message.channel];
            if (!socket) {
                // If, for some reason, a message is sent on a channel we don't have
                // a socket for, warn about it but don't bomb the stream
                console.warn('channel not understood for message', message);
                return;
            }
            try {
                const jMessage: wireProtocol.RawJupyterMessage = {
                    // Fold in the setup header to ease usage of messages on channels
                    header: { ...message.header, ...header },
                    parent_header: message.parent_header as any,
                    content: message.content,
                    metadata: message.metadata,
                    buffers: message.buffers as any,
                    idents: []
                };
                if ((socket as any).send !== undefined) {
                    await (socket as Dealer).send(wireProtocol.encode(jMessage));
                }
            } catch (err) {
                traceError('Error sending message', err, message);
            }
        },
        undefined, // not bothering with sending errors on
        () =>
            // When the subject is completed / disposed, close all the event
            // listeners and shutdown the socket
            Object.keys(sockets).forEach(name => {
                const socket = sockets[name];
                if (socket.close) {
                    socket.close();
                }
            })
    );

    // Messages from kernel on the sockets
    const incomingMessages: rxjs.Observable<JupyterMessage> = rxjs.merge(
        // Form an Observable with each socket
        ...Object.keys(sockets).map(name => {
            const socket = sockets[name];
            // fromEvent typings are broken. socket will work as an event target.
            return rxjs.fromEvent(
                // Pending a refactor around jmp, this allows us to treat the socket
                // as a normal event emitter
                (socket as unknown) as FromEventTarget<JupyterMessage>,
                'message'
            ).pipe(
                map(
                    (body: any): JupyterMessage => {
                        // Route the message for the frontend by setting the channel
                        const msg = { ...body, channel: name };
                        // Conform to same message format as notebook websockets
                        // See https://github.com/n-riesco/jmp/issues/10
                        delete (msg as any).idents;
                        return wireProtocol.decode(msg) as any;
                    }
                ),
                publish(),
                refCount()
            );
        })
    ).pipe(publish(), refCount());

    return rxjs.Subject.create(outgoingMessages, incomingMessages);
};

/**
 * Creates a multiplexed set of channels.
 *
 * @param  config                  Jupyter connection information
 * @param  config.ip               IP address of the kernel
 * @param  config.transport        Transport, e.g. TCP
 * @param  config.signature_scheme Hashing scheme, e.g. hmac-sha256
 * @param  config.iopub_port       Port for iopub channel
 * @param  subscription            subscribed topic; defaults to all
 * @param  identity                UUID
 *
 * @returns Subject containing multiplexed channels
 */
export const createMainChannel = async (
    config: JupyterConnectionInfo,
    subscription: string = '',
    identity: string = uuid(),
    header: HeaderFiller = {
        session: uuid(),
        username: getUsername()
    }
): Promise<Channels> => {
    const sockets = await createSockets(config, subscription, identity);
    return createMainChannelFromSockets(sockets, header);
};
