// ==UserScript==
// @name         NIIS Automation (GV SMS + Slybroadcast Voicemails)
// @namespace    http://tampermonkey.net/
// @version      5.4
// @downloadURL  https://raw.githubusercontent.com/midsummerred32/tampermonkey-scripts/master/NIIS%20Automation%20(GV%20SMS%20+%20Slybroadcast%20Voicemails)-5.2.user.js
// @updateURL    https://raw.githubusercontent.com/midsummerred32/tampermonkey-scripts/master/NIIS%20Automation%20(GV%20SMS%20+%20Slybroadcast%20Voicemails)-5.2.user.js
// @description  Automates NIIS SMS queues and Slybroadcast voicemail lists, with AI-assisted Google Voice scheduling, iCal availability, Telegram approval, and NIIS logging.
// @match        https://nationalis.com/ssecure/browser/inspector.cfm*
// @match        https://nationalis.com/ssecure/index.cfm*
// @match        https://voice.google.com/*
// @connect      nationalis.com
// @connect      localhost
// @connect      127.0.0.1
// @connect      calendar.google.com
// @connect      api.telegram.org
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        GM_addValueChangeListener
// ==/UserScript==

(function() {
    'use strict';

    const currentUrl = window.location.href;

    const AI_CONFIG = {
        ollamaUrl: GM_getValue('ollamaUrl', 'http://localhost:11434/api/generate'),
        ollamaModel: GM_getValue('ollamaModel', 'llama3.2:latest'),
        icalUrl: GM_getValue('icalUrl', ''),
        telegramToken: GM_getValue('telegramToken', ''),
        telegramChatId: GM_getValue('telegramChatId', ''),
        inspectionDurationHours: 3
    };

    GM_registerMenuCommand('Configure Google Calendar iCal URL', () => {
        const value = prompt('Paste your Google Calendar Secret iCal Address:', AI_CONFIG.icalUrl);
        if (value !== null) {
            AI_CONFIG.icalUrl = value.trim();
            GM_setValue('icalUrl', AI_CONFIG.icalUrl);
            alert('Calendar URL saved.');
        }
    });

    GM_registerMenuCommand('Configure Telegram Credentials', () => {
        const token = prompt('Enter Telegram Bot Token:', AI_CONFIG.telegramToken);
        if (token === null) return;
        const chatId = prompt('Enter your Telegram Chat ID:', AI_CONFIG.telegramChatId);
        if (chatId === null) return;

        AI_CONFIG.telegramToken = token.trim();
        AI_CONFIG.telegramChatId = chatId.trim();
        GM_setValue('telegramToken', AI_CONFIG.telegramToken);
        GM_setValue('telegramChatId', AI_CONFIG.telegramChatId);
        alert('Telegram credentials saved.');
    });

    GM_registerMenuCommand('Configure Ollama Settings', () => {
        const url = prompt('Enter Ollama Endpoint:', AI_CONFIG.ollamaUrl);
        if (url === null) return;
        const model = prompt('Enter Ollama Model Name:', AI_CONFIG.ollamaModel);
        if (model === null) return;

        AI_CONFIG.ollamaUrl = url.trim();
        AI_CONFIG.ollamaModel = model.trim();
        GM_setValue('ollamaUrl', AI_CONFIG.ollamaUrl);
        GM_setValue('ollamaModel', AI_CONFIG.ollamaModel);
        alert('Ollama settings saved.');
    });

    function getTodayKey() {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    // Helper: Strict & Accurate Appointment Check
    function checkApptStatus(row, html) {
        // FIX (v5.2): In the NIIS order list, each order row is wrapped in its own
        // <div class="subGroupContainer">. When an appointment is scheduled, the
        // "Appointment set for: ..." block is rendered as a SIBLING of that wrapper
        // div, not as a sibling of the order row itself. Checking row.nextElementSibling
        // directly always returned null (the row is the only child of its wrapper),
        // so scheduled appointments were silently missed and orders got queued anyway.
        if (row) {
            const container = row.closest('.subGroupContainer') || row;
            const apptSibling = container.nextElementSibling;
            if (apptSibling) {
                const nextText = (apptSibling.innerText || apptSibling.textContent || '').toUpperCase();
                if (nextText.includes('APPOINTMENT SET FOR:') || nextText.includes('APPT SET FOR:')) {
                    return true;
                }
            }
        }

        const inputApptMatch = html.match(/name=["']appt["'][^>]*value=["']([^"']+)["']/i) ||
                               html.match(/id=["']appt["'][^>]*value=["']([^"']+)["']/i);
        if (inputApptMatch && inputApptMatch[1]) {
            const val = inputApptMatch[1].trim().toUpperCase();
            if (val !== '' && !val.includes('UNSCHEDULED') && !val.includes('1/1/1900') && !val.includes('NONE')) {
                return true;
            }
        }

        const apptFieldMatch = html.match(/<td[^>]*>Appt:\s*<\/td>\s*<td[^>]*>([^<]+)/i) ||
                               html.match(/<td[^>]*>Appointment:\s*<\/td>\s*<td[^>]*>([^<]+)/i);
        if (apptFieldMatch && apptFieldMatch[1]) {
            const val = apptFieldMatch[1].trim().toUpperCase();
            if (val !== '' && !val.includes('UNSCHEDULED') && !val.includes('1/1/1900') && !val.includes('NONE')) {
                return true;
            }
        }

        return false;
    }

    // Helper: Remove Scheduled Appointments from Queue
    async function purgeScheduledFromQueue(updateBtnCallback) {
        let queue = GM_getValue('gv_sms_queue', []);
        if (queue.length === 0) {
            alert('Queue is empty!');
            return;
        }

        if (updateBtnCallback) updateBtnCallback('Checking Queue Appts...');

        let removedCount = 0;
        let newQueue = [];

        console.log(`--- Checking ${queue.length} queued items for newly scheduled appointments ---`);

        for (const item of queue) {
            try {
                const logUrl = `/ssecure/recordlog/form.cfm?id=${item.orderId}&appt=`;
                const response = await fetch(logUrl, { credentials: 'same-origin' });
                const html = await response.text();

                const row = document.querySelector(`div.hoverRow[data-ordid="${item.orderId}"]`) || document.querySelector(`tr[data-ordid="${item.orderId}"]`);

                if (checkApptStatus(row, html)) {
                    console.log(`🧹 [REMOVED APPOINTMENT] Order ${item.orderId} has an active scheduled appointment.`);
                    removedCount++;
                } else {
                    newQueue.push(item);
                }
            } catch (err) {
                console.error(`❌ Error verifying queue item ${item.orderId}:`, err);
                newQueue.push(item);
            }
            await new Promise(r => setTimeout(r, 400));
        }

        GM_setValue('gv_sms_queue', newQueue);
        alert(`Cleanup Complete!\n\n• Removed ${removedCount} scheduled orders from the queue.\n• ${newQueue.length} items remain in queue.`);

        if (updateBtnCallback) updateBtnCallback('Remove Scheduled Appts');
    }

    // Shared Logging Helper
    async function logToNIIS(orderId, clientId, customNotes = 'Left message.') {
        const now = new Date();
        const mm = String(now.getMonth() + 1).padStart(2, '0');
        const dd = String(now.getDate()).padStart(2, '0');
        const yyyy = now.getFullYear();
        const currentDate = `${mm}/${dd}/${yyyy}`;

        let hours = now.getHours();
        const amPm = hours >= 12 ? 'PM' : 'AM';
        hours = hours % 12;
        hours = hours ? hours : 12;
        const minutes = String(now.getMinutes()).padStart(2, '0');
        const currentTime = `${hours}:${minutes}`;

        const params = new URLSearchParams();
        params.append('orderid', orderId);
        params.append('clientid', clientId || '185');
        params.append('fieldrep', '7287');
        params.append('RecordLogCode', '106');
        params.append('Att_PhDate', currentDate);
        params.append('Att_PhTime', currentTime);
        params.append('Att_PhTimeAP', amPm);
        params.append('Att_PhType', '1');
        params.append('Att_PhAttempt', '2');
        params.append('notes', customNotes);

        const payloadStr = params.toString();

        return new Promise((resolve) => {
            GM_xmlhttpRequest({
                method: "POST",
                url: "https://nationalis.com/ssecure/recordlog/form_action.cfm",
                data: payloadStr,
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                    "X-Requested-With": "XMLHttpRequest"
                },
                onload: function(response) {
                    if (response.status === 200) {
                        markAsLogged(orderId);
                        console.log(`📝 [GM_XHR SUCCESS] Logged "${customNotes}" for Order ${orderId}`);
                        resolve(true);
                    } else {
                        console.error(`❌ [LOG FAILURE] Order ${orderId} status: ${response.status}`);
                        resolve(false);
                    }
                },
                onerror: function(err) {
                    console.error(`❌ [GM_XHR ERROR] Failed for Order ${orderId}:`, err);
                    resolve(false);
                }
            });
        });
    }

    function markAsLogged(orderId) {
        const todayKey = getTodayKey();
        const sentTodayTracker = GM_getValue('gv_sent_today', {});
        if (!sentTodayTracker[todayKey]) sentTodayTracker[todayKey] = [];
        if (!sentTodayTracker[todayKey].includes(orderId)) sentTodayTracker[todayKey].push(orderId);
        GM_setValue('gv_sent_today', sentTodayTracker);
    }

    function parseICalDate(dateStr) {
        const clean = dateStr?.trim();
        if (!clean) return null;

        if (/^\d{8}$/.test(clean)) {
            return new Date(
                Number(clean.slice(0, 4)),
                Number(clean.slice(4, 6)) - 1,
                Number(clean.slice(6, 8))
            );
        }

        const match = clean.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
        if (match) {
            const [, year, month, day, hour, minute, second, isUtc] = match;
            const parts = [+year, +month - 1, +day, +hour, +minute, +second];
            return isUtc
                ? new Date(Date.UTC(...parts))
                : new Date(...parts);
        }

        const parsed = new Date(clean);
        return Number.isNaN(parsed.getTime()) ? null : parsed;
    }

    function fetchBusyEvents() {
        return new Promise((resolve, reject) => {
            if (!AI_CONFIG.icalUrl) {
                reject(new Error('Configure your Google Calendar iCal URL from the Tampermonkey menu first.'));
                return;
            }

            GM_xmlhttpRequest({
                method: 'GET',
                url: AI_CONFIG.icalUrl,
                headers: { 'Cache-Control': 'no-cache' },
                timeout: 15000,
                onload: (response) => {
                    if (response.status < 200 || response.status >= 300) {
                        reject(new Error(`Failed to load calendar: HTTP ${response.status}`));
                        return;
                    }

                    const eventMatches = [...response.responseText.matchAll(/BEGIN:VEVENT([\s\S]*?)END:VEVENT/g)];
                    const busyRanges = [];
                    for (const match of eventMatches) {
                        const startMatch = match[1].match(/DTSTART(?:;[^:]+)?:([^\r\n]+)/);
                        const endMatch = match[1].match(/DTEND(?:;[^:]+)?:([^\r\n]+)/);
                        const start = startMatch && parseICalDate(startMatch[1]);
                        const end = endMatch
                            ? parseICalDate(endMatch[1])
                            : start && new Date(start.getTime() + 3600000);
                        if (start && end && end > start) busyRanges.push({ start, end });
                    }
                    resolve(busyRanges);
                },
                ontimeout: () => reject(new Error('Timed out loading the Google Calendar iCal feed.')),
                onerror: (error) => reject(new Error(`Failed to load calendar: ${error?.error || 'network error'}`))
            });
        });
    }

    async function getAvailableInspectionSlots() {
        const busyRanges = await fetchBusyEvents();
        const slots = [];
        const checkDate = new Date();
        checkDate.setDate(checkDate.getDate() + 1);

        for (let daysAhead = 0; daysAhead < 60 && slots.length < 3; daysAhead++) {
            if (checkDate.getDay() !== 0 && checkDate.getDay() !== 6) {
                for (const hour of [9, 13]) {
                    const minute = hour === 13 ? 30 : 0;
                    const start = new Date(
                        checkDate.getFullYear(),
                        checkDate.getMonth(),
                        checkDate.getDate(),
                        hour,
                        minute
                    );
                    const end = new Date(start.getTime() + AI_CONFIG.inspectionDurationHours * 3600000);
                    if (!busyRanges.some(event => start < event.end && end > event.start)) {
                        const dayLabel = checkDate.toLocaleDateString('en-US', {
                            weekday: 'long',
                            month: 'short',
                            day: 'numeric'
                        });
                        const timeLabel = hour === 9 ? '9:00 AM' : '1:30 PM';
                        slots.push(`${dayLabel} at ${timeLabel}`);
                        if (slots.length === 3) break;
                    }
                }
            }
            checkDate.setDate(checkDate.getDate() + 1);
        }

        if (slots.length === 0) {
            throw new Error('No available inspection slots were found in the next 60 days.');
        }
        return slots.join(', or ');
    }

    function generateAIReply(clientMessage, slots) {
        const prompt = `You are a professional home inspection scheduling assistant.
A client sent this message: "${clientMessage}".
Our current confirmed inspection openings are: ${slots}.

Suggest two of these confirmed openings politely, keep the reply to 1-2 friendly concise SMS sentences, and ask whether either time works or they need another window. Output only the message text.`;

        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'POST',
                url: AI_CONFIG.ollamaUrl,
                headers: { 'Content-Type': 'application/json' },
                data: JSON.stringify({
                    model: AI_CONFIG.ollamaModel,
                    prompt,
                    stream: false
                }),
                timeout: 120000,
                onload: (response) => {
                    if (response.status < 200 || response.status >= 300) {
                        reject(new Error(`Ollama request failed: HTTP ${response.status}`));
                        return;
                    }
                    try {
                        const result = JSON.parse(response.responseText);
                        if (typeof result.response !== 'string' || !result.response.trim()) {
                            throw new Error('Ollama returned an empty reply.');
                        }
                        resolve(result.response.trim());
                    } catch (error) {
                        reject(new Error(`Invalid Ollama response: ${error.message}`));
                    }
                },
                ontimeout: () => reject(new Error('Ollama request timed out.')),
                onerror: () => reject(new Error('Could not connect to Ollama. Check that it is running and accessible.'))
            });
        });
    }

    function sendTelegramApprovalRequest(client, clientText, draft, callbackId) {
        if (!AI_CONFIG.telegramToken || !AI_CONFIG.telegramChatId) {
            return Promise.reject(new Error('Configure the Telegram bot token and chat ID from the Tampermonkey menu first.'));
        }

        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'POST',
                url: `https://api.telegram.org/bot${AI_CONFIG.telegramToken}/sendMessage`,
                headers: { 'Content-Type': 'application/json' },
                data: JSON.stringify({
                    chat_id: AI_CONFIG.telegramChatId,
                    text: `New inspection inquiry\nClient: ${client.name} (${client.phone})\nMessage: ${clientText}\n\nAI draft:\n${draft}`,
                    reply_markup: {
                        inline_keyboard: [[
                            { text: 'Approve & Send SMS', callback_data: `send_${callbackId}` },
                            { text: 'Reject Draft', callback_data: `reject_${callbackId}` }
                        ]]
                    }
                }),
                onload: (response) => {
                    try {
                        const result = JSON.parse(response.responseText);
                        if (response.status >= 200 && response.status < 300 && result.ok) {
                            resolve(result.result);
                        } else {
                            reject(new Error(result.description || `Telegram request failed: HTTP ${response.status}`));
                        }
                    } catch (error) {
                        reject(new Error(`Invalid Telegram response: ${error.message}`));
                    }
                },
                onerror: () => reject(new Error('Could not connect to Telegram.'))
            });
        });
    }

    function acknowledgeTelegramCallback(queryId, text) {
        GM_xmlhttpRequest({
            method: 'POST',
            url: `https://api.telegram.org/bot${AI_CONFIG.telegramToken}/answerCallbackQuery`,
            headers: { 'Content-Type': 'application/json' },
            data: JSON.stringify({ callback_query_id: queryId, text })
        });
    }

    function pollTelegramDecision(callbackId, timeoutMs = 300000) {
        return new Promise((resolve, reject) => {
            const startTime = Date.now();
            let lastUpdateId = 0;

            const check = () => {
                if (Date.now() - startTime >= timeoutMs) {
                    resolve('timeout');
                    return;
                }

                GM_xmlhttpRequest({
                    method: 'GET',
                    url: `https://api.telegram.org/bot${AI_CONFIG.telegramToken}/getUpdates?offset=${lastUpdateId}&timeout=5`,
                    onload: (response) => {
                        try {
                            const result = JSON.parse(response.responseText);
                            if (!result.ok) throw new Error(result.description || 'Telegram polling failed.');
                            for (const update of result.result || []) {
                                lastUpdateId = update.update_id + 1;
                                const callback = update.callback_query;
                                if (!callback?.data) continue;
                                if (callback.data === `send_${callbackId}`) {
                                    acknowledgeTelegramCallback(callback.id, 'Approved. Sending SMS.');
                                    resolve('approved');
                                    return;
                                }
                                if (callback.data === `reject_${callbackId}`) {
                                    acknowledgeTelegramCallback(callback.id, 'Draft rejected.');
                                    resolve('rejected');
                                    return;
                                }
                            }
                            setTimeout(check, 2500);
                        } catch (error) {
                            reject(new Error(`Telegram polling failed: ${error.message}`));
                        }
                    },
                    onerror: () => reject(new Error('Could not poll Telegram for an approval decision.'))
                });
            };
            check();
        });
    }

    function getMessageInputField() {
        const selectors = [
            'textarea[aria-label*="message" i]',
            'textarea[placeholder*="message" i]',
            '[contenteditable="true"][aria-label*="message" i]',
            '[contenteditable="true"][data-placeholder*="message" i]',
            '[role="textbox"][aria-label*="message" i]',
            '[role="textbox"][data-placeholder*="message" i]',
            'textarea',
            '[contenteditable="true"]',
            '[role="textbox"]'
        ];

        for (const selector of selectors) {
            const field = Array.from(document.querySelectorAll(selector)).find((candidate) => {
                if (candidate.closest('#gv-copilot-container')) return false;
                if (candidate.disabled || candidate.readOnly || candidate.getAttribute('aria-hidden') === 'true') return false;
                const description = [
                    candidate.getAttribute('aria-label'),
                    candidate.getAttribute('placeholder'),
                    candidate.getAttribute('data-placeholder')
                ].filter(Boolean).join(' ');
                return !/search|filter/i.test(description) && candidate.getClientRects().length > 0;
            });
            if (field) return field;
        }
        return null;
    }

    function getActiveThreadMessages() {
        return Array.from(document.querySelectorAll('gv-text-message-item, div[gv-test-id="item-view"]'))
            .map(message => message.innerText.trim())
            .filter(Boolean);
    }

    function getActiveClientDetails() {
        const header = document.querySelector('header, gv-conversation-header');
        const headerText = header?.innerText || '';
        const phoneMatch = headerText.match(/\+?1?\s*\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/);
        return {
            name: header?.querySelector('h1')?.innerText.trim() || 'Unknown Client',
            phone: phoneMatch ? phoneMatch[0].trim() : 'Unknown Phone'
        };
    }

    function normalizePhone(phone) {
        return String(phone || '').replace(/\D/g, '').slice(-10);
    }

    async function humanTypeIntoField(field, text) {
        field.focus();
        if (field instanceof HTMLTextAreaElement) {
            field.value = '';
            field.dispatchEvent(new Event('input', { bubbles: true }));
        }

        for (const character of text) {
            if (field instanceof HTMLTextAreaElement) {
                field.value += character;
                field.dispatchEvent(new Event('input', { bubbles: true }));
            } else {
                document.execCommand('insertText', false, character);
            }
            const delay = Math.floor(Math.random() * 81) + 40 + (/[.,!?]/.test(character) ? 200 : character === ' ' ? 60 : 0);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
        field.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function broadcastAIAttemptToNIIS(payload) {
        GM_setValue('latest_national_sync_event', {
            id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            timestamp: new Date().toISOString(),
            action: 'SMS_SENT',
            ...payload
        });
    }

    async function logAIAttemptToNIIS(event) {
        const phoneDigits = String(event.phone || '').replace(/\D/g, '').slice(-10);
        if (phoneDigits.length !== 10) {
            console.error('[NIIS] Cannot sync AI SMS: client phone number is missing or invalid.');
            return;
        }
        const containsPhone = (text) => {
            const phoneMatches = String(text).match(/(?:\+?1[\s().-]*)?\d{3}[\s().-]*\d{3}[\s.-]*\d{4}/g) || [];
            return phoneMatches.some(phone => phone.replace(/\D/g, '').slice(-10) === phoneDigits);
        };

        const rows = new Map();
        document.querySelectorAll('div.hoverRow[data-ordid], tr[data-ordid]').forEach((row) => {
            const orderId = row.getAttribute('data-ordid');
            if (orderId && !rows.has(orderId)) {
                rows.set(orderId, {
                    row,
                    clientId: row.getAttribute('data-clid')
                });
            }
        });

        const matches = [];
        for (const [orderId, item] of rows) {
            let foundPhone = containsPhone(item.row.innerText || item.row.textContent || '');

            if (!foundPhone) {
                try {
                    const response = await fetch(
                        `/ssecure/recordlog/form.cfm?id=${encodeURIComponent(orderId)}&appt=`,
                        { credentials: 'same-origin' }
                    );
                    if (!response.ok) throw new Error(`HTTP ${response.status}`);
                    const html = await response.text();
                    const phoneMatch = html.match(/(?:Mobile )?Phone:<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/i);
                    foundPhone = phoneMatch && containsPhone(phoneMatch[1].replace(/<[^>]+>/g, ' '));
                } catch (error) {
                    console.error(`[NIIS] Could not verify order ${orderId} for AI SMS sync:`, error);
                    continue;
                }
            }

            if (foundPhone) matches.push({ orderId, clientId: item.clientId });
        }

        if (matches.length !== 1) {
            console.error(`[NIIS] AI SMS sync needs exactly one matching order for ${phoneDigits}; found ${matches.length}. No order was changed.`);
            return;
        }

        const note = `AI SMS sent: ${String(event.draftText || '').slice(0, 120)}`;
        if (!await logToNIIS(matches[0].orderId, matches[0].clientId, note)) {
            console.error(`[NIIS] Failed to save AI SMS activity for order ${matches[0].orderId}.`);
        }
    }

    if (currentUrl.includes('nationalis.com')) {
        GM_addValueChangeListener('latest_national_sync_event', (_name, _oldValue, newValue) => {
            if (newValue?.action !== 'SMS_SENT' || !newValue.id) return;
            GM_setValue('latest_national_sync_claim', newValue.id);
            setTimeout(() => {
                if (GM_getValue('latest_national_sync_claim') === newValue.id) {
                    logAIAttemptToNIIS(newValue);
                }
            }, 1000);
        });
    }

    // =========================================================================
    // UI MODAL: QUEUE MANAGER INTERFACE
    // =========================================================================
    function createQueueModal() {
        if (document.getElementById('gv-queue-modal')) return;

        const modal = document.createElement('div');
        modal.id = 'gv-queue-modal';
        modal.style.cssText = `
            display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%;
            background: rgba(0, 0, 0, 0.6); z-index: 100000; justify-content: center; align-items: center;
            font-family: Arial, sans-serif;
        `;

        modal.innerHTML = `
            <div style="background: #fff; border-radius: 8px; width: 80%; max-width: 850px; max-height: 85vh; display: flex; flex-direction: column; box-shadow: 0 10px 25px rgba(0,0,0,0.3); overflow: hidden;">
                <div style="padding: 15px 20px; background: #1a73e8; color: white; display: flex; justify-content: space-between; align-items: center;">
                    <h3 style="margin: 0; font-size: 18px;">📋 SMS Queue Manager</h3>
                    <button id="close-modal-btn" style="background: transparent; border: none; color: white; font-size: 20px; cursor: pointer; font-weight: bold;">&times;</button>
                </div>
                <div style="padding: 12px 20px 0;">
                    <input id="queue-search-input" type="search" placeholder="Search by name, address, or phone" style="box-sizing: border-box; width: 100%; padding: 9px 10px; border: 1px solid #ced4da; border-radius: 4px; font-size: 14px;">
                </div>
                <div id="modal-queue-list" style="padding: 20px; overflow-y: auto; flex-grow: 1;">
                    <!-- Dynamic Queue Content -->
                </div>
                <div style="padding: 12px 20px; background: #f8f9fa; border-top: 1px solid #dee2e6; display: flex; justify-content: space-between; align-items: center;">
                    ${currentUrl.includes('nationalis.com') ? `<button id="modal-purge-appt-btn" style="padding: 8px 14px; background: #6f42c1; color: white; border: none; border-radius: 4px; cursor: pointer; font-weight: bold;">🧹 Remove Scheduled Appts</button>` : '<div></div>'}
                    <button id="modal-done-btn" style="padding: 8px 16px; background: #6c757d; color: white; border: none; border-radius: 4px; cursor: pointer; font-weight: bold;">Close</button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);

        document.getElementById('close-modal-btn').onclick = () => modal.style.display = 'none';
        document.getElementById('modal-done-btn').onclick = () => modal.style.display = 'none';
        document.getElementById('queue-search-input').addEventListener('input', renderQueueModal);

        const purgeModalBtn = document.getElementById('modal-purge-appt-btn');
        if (purgeModalBtn) {
            purgeModalBtn.onclick = async () => {
                await purgeScheduledFromQueue((msg) => { purgeModalBtn.textContent = msg; });
                renderQueueModal();
            };
        }
    }

    function renderQueueModal() {
        createQueueModal();
        const modal = document.getElementById('gv-queue-modal');
        const listContainer = document.getElementById('modal-queue-list');
        const searchQuery = document.getElementById('queue-search-input').value.trim().toLowerCase();
        let queue = GM_getValue('gv_sms_queue', []);
        const visibleItems = queue
            .map((item, index) => ({ item, index }))
            .filter(({ item }) => [item.name, item.searchText, item.location, item.phone, item.message]
                .some(value => String(value || '').toLowerCase().includes(searchQuery)));

        if (queue.length === 0) {
            listContainer.innerHTML = '<p style="text-align: center; color: #6c757d; font-size: 16px; padding: 20px;">The queue is currently empty.</p>';
        } else if (visibleItems.length === 0) {
            listContainer.innerHTML = '<p style="text-align: center; color: #6c757d; font-size: 16px; padding: 20px;">No matching queue items.</p>';
        } else {
            listContainer.innerHTML = visibleItems.map(({ item, index }) => `
                <div style="border: 1px solid #e0e0e0; border-radius: 6px; padding: 12px 15px; margin-bottom: 12px; background: #fdfdfd; display: flex; flex-direction: column; gap: 8px;">
                    <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #eee; padding-bottom: 6px;">
                        <span style="font-weight: bold; color: #1a73e8;">#${index + 1} | Order ID: ${item.orderId || 'N/A'}</span>
                        <div>
                            <button class="edit-queue-btn" data-index="${index}" style="padding: 4px 10px; background: #ffc107; color: #000; border: none; border-radius: 3px; cursor: pointer; font-size: 12px; font-weight: bold; margin-right: 5px;">Edit</button>
                            <button class="delete-queue-btn" data-index="${index}" style="padding: 4px 10px; background: #dc3545; color: white; border: none; border-radius: 3px; cursor: pointer; font-size: 12px; font-weight: bold;">Delete</button>
                        </div>
                    </div>
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; font-size: 13px;">
                        <div><strong>📍 Address:</strong> <span id="add-text-${index}">${item.location || 'N/A'}</span></div>
                        <div><strong>📞 Phone:</strong> <span id="phone-text-${index}">${item.phone || 'N/A'}</span></div>
                    </div>
                    <div style="font-size: 12px; background: #f1f3f4; padding: 8px; border-radius: 4px; white-space: pre-wrap; font-family: monospace; color: #333;" id="msg-text-${index}">${item.message}</div>
                </div>
            `).join('');

            document.querySelectorAll('.delete-queue-btn').forEach(btn => {
                btn.onclick = (e) => {
                    const idx = parseInt(e.target.getAttribute('data-index'));
                    let currentQueue = GM_getValue('gv_sms_queue', []);
                    currentQueue.splice(idx, 1);
                    GM_setValue('gv_sms_queue', currentQueue);
                    renderQueueModal();
                };
            });

            document.querySelectorAll('.edit-queue-btn').forEach(btn => {
                btn.onclick = (e) => {
                    const idx = parseInt(e.target.getAttribute('data-index'));
                    let currentQueue = GM_getValue('gv_sms_queue', []);
                    const item = currentQueue[idx];

                    const newPhone = prompt("Edit Phone Number:", item.phone);
                    if (newPhone === null) return;
                    currentQueue[idx].phone = newPhone.trim();
                    GM_setValue('gv_sms_queue', currentQueue);

                    const newAddress = prompt("Edit Property Address:", item.location);
                    if (newAddress === null) {
                        renderQueueModal();
                        return;
                    }
                    currentQueue[idx].location = newAddress.trim();
                    GM_setValue('gv_sms_queue', currentQueue);

                    const newMessage = prompt("Edit Message Text:", item.message);
                    if (newMessage === null) {
                        renderQueueModal();
                        return;
                    }

                    currentQueue[idx].message = newMessage.trim();

                    GM_setValue('gv_sms_queue', currentQueue);
                    renderQueueModal();
                };
            });
        }

        modal.style.display = 'flex';
    }

    // =========================================================================
    // SECTION 1: NIIS PAGE LOGIC (nationalis.com)
    // =========================================================================
    if (currentUrl.includes('nationalis.com')) {

        let forceOverride = false;

        function buildMessage(countyType, address) {
            const header = address ? `Property: ${address}` : `Property:`;

            if (countyType === 'SUMMIT') {
                return `${header}\n\nHi, I'm Matt Leavitt, working with USAA Insurance to schedule your homeowner's insurance photos. I'll photograph your kitchen, bathrooms, living room, basement mechanical, and home exterior. No bedrooms. It takes 5-10 minutes. Please click the link to schedule, or text me a convenient time. https://calendar.app.google/fWPmDgqDttaaTuAj6 Thanks, Matt.`;
            } else if (countyType === 'CUYAHOGA') {
                return `${header}\n\nHi, I'm Matt Leavitt, working with USAA Insurance to schedule your homeowner's insurance photos. I'll photograph your kitchen, bathrooms, living room, basement mechanical, and home exterior. No bedrooms. It takes 5-10 minutes. Please click the link to schedule, or text me a convenient time. https://calendar.app.google/7V2LSUk2AH3rGoiY9 Thanks, Matt.`;
            } else {
                return `${header}\n\nHi, I'm Matt Leavitt, working with USAA Insurance to schedule your homeowner's insurance photos. I'll photograph your kitchen, bathrooms, living room, basement mechanical, and home exterior. No bedrooms. It takes 5-10 minutes. Please text me back a convenient time to schedule. Thanks, Matt.`;
            }
        }

        function isAlreadySentToday(orderId, html) {
            if (forceOverride) return false;

            const todayKey = getTodayKey();
            const sentTodayTracker = GM_getValue('gv_sent_today', {});

            if (sentTodayTracker[todayKey] && sentTodayTracker[todayKey].includes(orderId)) {
                return true;
            }

            const now = new Date();
            const mm = String(now.getMonth() + 1).padStart(2, '0');
            const m = String(now.getMonth() + 1);
            const dd = String(now.getDate()).padStart(2, '0');
            const d = String(now.getDate());
            const yyyy = now.getFullYear();

            const datePatterns = [`${mm}/${dd}/${yyyy}`, `${m}/${d}/${yyyy}`, `${yyyy}-${mm}-${dd}`];

            const parser = new DOMParser();
            const doc = parser.parseFromString(html, 'text/html');
            const logRows = doc.querySelectorAll('tr');

            for (const tr of logRows) {
                const text = tr.innerText || tr.textContent || '';
                if (datePatterns.some(p => text.includes(p)) && (text.includes('Left message') || text.includes('106'))) {
                    return true;
                }
            }
            return false;
        }

        // Extracts phone numbers into a line-separated list (\n), copies to clipboard, and logs in NIIS
        async function processVoicemailsForRows(targetRows, btnElement, label) {
            btnElement.textContent = `Extracting ${label}...`;
            btnElement.disabled = true;

            let phoneNumbers = [];
            let skippedCount = 0;

            console.log(`--- Extracting Slybroadcast phone numbers for ${targetRows.length} ${label} rows ---`);

            for (const row of targetRows) {
                const orderId = row.getAttribute('data-ordid');
                const clientId = row.getAttribute('data-clid');

                if (!orderId) continue;

                try {
                    const logUrl = `/ssecure/recordlog/form.cfm?id=${orderId}&appt=`;
                    const response = await fetch(logUrl, { credentials: 'same-origin' });
                    const html = await response.text();

                    if (checkApptStatus(row, html) || isAlreadySentToday(orderId, html)) {
                        skippedCount++;
                        continue;
                    }

                    let phoneMatch = html.match(/Mobile Phone:<\/td>\s*<td[^>]*>(\d+)/i) || html.match(/Phone:<\/td>\s*<td[^>]*>(\d+)/i);

                    if (phoneMatch && phoneMatch[1]) {
                        const phone = phoneMatch[1].trim();
                        if (!phoneNumbers.includes(phone)) {
                            phoneNumbers.push(phone);
                        }
                        await logToNIIS(orderId, clientId, 'Left message (Automated Slybroadcast).');
                    } else {
                        console.warn(`⚠️ No valid phone number found for Order ${orderId}`);
                    }
                } catch (err) {
                    console.error(`❌ Error processing order ${orderId} for voicemail:`, err);
                }

                await new Promise(r => setTimeout(r, 400));
            }

            if (phoneNumbers.length > 0) {
                const phoneListStr = phoneNumbers.join('\n');
                try {
                    await navigator.clipboard.writeText(phoneListStr);
                    alert(`✅ Copied ${phoneNumbers.length} phone numbers (one per line) to clipboard!\n\nReady to paste into Slybroadcast.`);
                } catch (clipErr) {
                    prompt(`Copy phone numbers below for Slybroadcast:`, phoneListStr);
                }
            } else {
                alert(`No eligible orders found to extract phone numbers (${skippedCount} skipped).`);
            }

            btnElement.textContent = `Done (${phoneNumbers.length} Extracted, ${skippedCount} Skipped)`;
            setTimeout(() => {
                btnElement.textContent = label;
                btnElement.disabled = false;
            }, 3000);
        }

        // Floating UI Controls
        const container = document.createElement('div');
        container.style.cssText = 'position:fixed; top:55px; right:10px; z-index:9999; display:flex; gap:8px; flex-wrap:wrap; justify-content:flex-end; max-width:90vw;';

        const btn = document.createElement('button');
        btn.textContent = 'Queue Texts for Google Voice';
        btn.style.cssText = 'padding:10px 14px; background:#28a745; color:white; border:none; border-radius:4px; cursor:pointer; font-weight:bold;';

        const overrideBtn = document.createElement('button');
        overrideBtn.textContent = 'Force Re-Queue: OFF';
        overrideBtn.style.cssText = 'padding:10px 12px; background:#6c757d; color:white; border:none; border-radius:4px; cursor:pointer; font-weight:bold;';

        const vmBtn = document.createElement('button');
        vmBtn.textContent = 'Copy VMs List (Unscheduled)';
        vmBtn.style.cssText = 'padding:10px 14px; background:#0056b3; color:white; border:none; border-radius:4px; cursor:pointer; font-weight:bold;';

        const vmRedBtn = document.createElement('button');
        vmRedBtn.textContent = 'Copy VMs List (Red Orders)';
        vmRedBtn.style.cssText = 'padding:10px 14px; background:#8b0000; color:white; border:none; border-radius:4px; cursor:pointer; font-weight:bold;';

        const editQueueBtn = document.createElement('button');
        editQueueBtn.textContent = 'Manage Queue';
        editQueueBtn.style.cssText = 'padding:10px 14px; background:#17a2b8; color:white; border:none; border-radius:4px; cursor:pointer; font-weight:bold;';

        const removeApptBtn = document.createElement('button');
        removeApptBtn.textContent = 'Remove Scheduled Appts';
        removeApptBtn.style.cssText = 'padding:10px 14px; background:#6f42c1; color:white; border:none; border-radius:4px; cursor:pointer; font-weight:bold;';

        const syncLogsBtn = document.createElement('button');
        syncLogsBtn.textContent = 'Sync & Audit Logs';
        syncLogsBtn.style.cssText = 'padding:10px 14px; background:#fd7e14; color:white; border:none; border-radius:4px; cursor:pointer; font-weight:bold;';

        container.appendChild(btn);
        container.appendChild(overrideBtn);
        container.appendChild(vmBtn);
        container.appendChild(vmRedBtn);
        container.appendChild(editQueueBtn);
        container.appendChild(removeApptBtn);
        container.appendChild(syncLogsBtn);
        document.body.appendChild(container);

        overrideBtn.addEventListener('click', () => {
            forceOverride = !forceOverride;
            if (forceOverride) {
                overrideBtn.textContent = 'Force Re-Queue: ON';
                overrideBtn.style.background = '#dc3545';
            } else {
                overrideBtn.textContent = 'Force Re-Queue: OFF';
                overrideBtn.style.background = '#6c757d';
            }
        });

        editQueueBtn.addEventListener('click', renderQueueModal);

        removeApptBtn.addEventListener('click', async () => {
            removeApptBtn.disabled = true;
            await purgeScheduledFromQueue((msg) => { removeApptBtn.textContent = msg; });
            removeApptBtn.disabled = false;
        });

        // SLYBROADCAST VOICEMAIL LIST GENERATOR (BLUE / UNSCHEDULED)
        vmBtn.addEventListener('click', async () => {
            const targetRows = document.querySelectorAll('div.setBlue.hoverRow, tr.setBlue');
            await processVoicemailsForRows(targetRows, vmBtn, 'Copy VMs List (Unscheduled)');
        });

        // SLYBROADCAST VOICEMAIL LIST GENERATOR (RED / PRIORITY ORDERS)
        vmRedBtn.addEventListener('click', async () => {
            const targetRows = document.querySelectorAll('div.setRed.hoverRow, tr.setRed');
            await processVoicemailsForRows(targetRows, vmRedBtn, 'Copy VMs List (Red Orders)');
        });

        syncLogsBtn.addEventListener('click', async () => {
            syncLogsBtn.textContent = 'Auditing NIIS Logs...';
            syncLogsBtn.disabled = true;

            const todayKey = getTodayKey();
            const sentTodayTracker = GM_getValue('gv_sent_today', {});
            const sentTodayOrders = sentTodayTracker[todayKey] || [];

            const allRows = document.querySelectorAll('div.hoverRow[data-ordid], tr[data-ordid]');
            let fixedCount = 0;
            let verifiedCount = 0;

            console.log(`--- Starting Log Audit across ${allRows.length} visible orders ---`);

            for (const row of allRows) {
                const orderId = row.getAttribute('data-ordid');
                const clientId = row.getAttribute('data-clid');

                const isLoggedLocally = sentTodayOrders.includes(orderId);

                if (isLoggedLocally) {
                    try {
                        const logUrl = `/ssecure/recordlog/form.cfm?id=${orderId}&appt=`;
                        const response = await fetch(logUrl, { credentials: 'same-origin' });
                        const html = await response.text();

                        const now = new Date();
                        const mm = String(now.getMonth() + 1).padStart(2, '0');
                        const m = String(now.getMonth() + 1);
                        const dd = String(now.getDate()).padStart(2, '0');
                        const d = String(now.getDate());
                        const yyyy = now.getFullYear();

                        const datePatterns = [`${mm}/${dd}/${yyyy}`, `${m}/${d}/${yyyy}`, `${yyyy}-${mm}-${dd}`];

                        const parser = new DOMParser();
                        const doc = parser.parseFromString(html, 'text/html');
                        const logRows = doc.querySelectorAll('tr');

                        let existsInNIIS = false;
                        for (const tr of logRows) {
                            const text = tr.innerText || tr.textContent || '';
                            if (datePatterns.some(p => text.includes(p)) && (text.includes('Left message') || text.includes('106'))) {
                                existsInNIIS = true;
                                break;
                            }
                        }

                        if (!existsInNIIS) {
                            console.warn(`⚠️ [MISMATCH DETECTED] Order ${orderId} missing in NIIS. Syncing now...`);
                            await logToNIIS(orderId, clientId);
                            fixedCount++;
                        } else {
                            verifiedCount++;
                        }
                    } catch (err) {
                        console.error(`❌ Error verifying log for Order ${orderId}:`, err);
                    }
                }
                await new Promise(r => setTimeout(r, 400));
            }

            alert(`Log Audit Complete!\n\n• Verified NIIS Logs: ${verifiedCount}\n• Fixed Missing NIIS Logs: ${fixedCount}`);
            syncLogsBtn.textContent = 'Sync & Audit Logs';
            syncLogsBtn.disabled = false;
        });

        btn.addEventListener('click', async () => {
            btn.textContent = 'Processing Orders...';
            btn.disabled = true;

            const allRows = document.querySelectorAll('div.hoverRow[data-ordid], tr[data-ordid]');
            let queue = GM_getValue('gv_sms_queue', []);
            let addedCount = 0;
            let skippedSentTodayCount = 0;
            let skippedApptCount = 0;

            console.log(`--- Starting SMS Queue processing for ${allRows.length} total rows ---`);

            for (const row of allRows) {
                const orderId = row.getAttribute('data-ordid');
                const clientId = row.getAttribute('data-clid');

                try {
                    const logUrl = `/ssecure/recordlog/form.cfm?id=${orderId}&appt=`;
                    const response = await fetch(logUrl, { credentials: 'same-origin' });
                    const html = await response.text();

                    if (checkApptStatus(row, html)) {
                        skippedApptCount++;
                        continue;
                    }

                    if (isAlreadySentToday(orderId, html)) {
                        skippedSentTodayCount++;
                        continue;
                    }

                    let phoneMatch = html.match(/Mobile Phone:<\/td>\s*<td[^>]*>(\d+)/i) || html.match(/Phone:<\/td>\s*<td[^>]*>(\d+)/i);
                    let cszMatch = html.match(/City\/State\/Zip:<\/td>\s*<td[^>]*>([^<]+)/i);
                    let streetMatch = html.match(/(?:Property Address|Address|Street):<\/td>\s*<td[^>]*>([^<]+)/i);

                    if (phoneMatch && phoneMatch[1] && cszMatch && cszMatch[1]) {
                        const phone = phoneMatch[1].trim();
                        const cszText = cszMatch[1].trim().toUpperCase();
                        const zipMatch = cszText.match(/\b\d{5}\b/);
                        const zip = zipMatch ? zipMatch[0] : '';

                        let formattedAddress = '';
                        if (streetMatch && streetMatch[1]) {
                            const street = streetMatch[1].trim();
                            const city = cszText.split(',')[0].trim();
                            formattedAddress = city ? `${street}, ${city}` : street;
                        } else {
                            formattedAddress = cszText;
                        }

                        let countyType = '';

                        if (
                            zip.startsWith('443') ||
                            (zip.startsWith('442') && (
                                cszText.includes('CUYAHOGA FLS') || cszText.includes('CUYAHOGA FALLS') ||
                                cszText.includes('STOW') || cszText.includes('BARBERTON') ||
                                cszText.includes('HUDSON') || cszText.includes('TALLMADGE') ||
                                cszText.includes('GREEN') || cszText.includes('MACEDONIA') ||
                                cszText.includes('TWINSBURG')
                            )) || cszText.includes('AKRON')
                        ) {
                            countyType = 'SUMMIT';
                        } else if (
                            zip.startsWith('441') ||
                            cszText.includes('CLEVELAND') || cszText.includes('PARMA') ||
                            cszText.includes('LAKEWOOD') || cszText.includes('STRONGVILLE') ||
                            cszText.includes('BEREA') || cszText.includes('NORTH OLMSTED')
                        ) {
                            countyType = 'CUYAHOGA';
                        } else {
                            countyType = 'OTHER';
                        }

                        const textBody = buildMessage(countyType, formattedAddress);

                        if (!queue.some(item => item.orderId === orderId)) {
                            queue.push({
                                phone,
                                message: textBody,
                                orderId,
                                clientId,
                                location: formattedAddress,
                                searchText: row.innerText || row.textContent || ''
                            });
                            addedCount++;
                        }
                    }
                } catch (err) {
                    console.error(`❌ Error processing order ${orderId}:`, err);
                }

                await new Promise(r => setTimeout(r, 800));
            }

            GM_setValue('gv_sms_queue', queue);
            btn.textContent = `Queued ${addedCount} (${skippedApptCount + skippedSentTodayCount} skipped)`;
            setTimeout(() => {
                btn.textContent = 'Queue Texts for Google Voice';
                btn.disabled = false;
            }, 3000);
        });
    }

    function injectAICopilotWidget() {
        if (document.getElementById('gv-copilot-container')) return;

        const widget = document.createElement('section');
        widget.id = 'gv-copilot-container';
        widget.style.cssText = `
            position: fixed; right: 24px; bottom: 92px; z-index: 10000;
            width: 330px; box-sizing: border-box; padding: 14px 16px;
            color: #202124; background: #fff; border: 1px solid #dadce0;
            border-radius: 12px; box-shadow: 0 4px 16px rgba(60,64,67,.2);
            font: 13px Roboto, Arial, sans-serif;
        `;
        widget.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
                <strong style="color:#1a73e8">AI Scheduling Copilot</strong>
                <span id="gv-copilot-status" style="font-size:11px;color:#5f6368">Ready</span>
            </div>
            <p id="gv-copilot-detail" style="margin:0 0 10px;line-height:1.4;color:#3c4043">
                Draft a reply using calendar availability, or request Telegram approval.
            </p>
            <div style="display:flex;gap:6px">
                <button id="gv-ai-draft" style="flex:1;padding:8px 10px;background:#1a73e8;color:#fff;border:0;border-radius:6px;cursor:pointer">Draft</button>
                <button id="gv-ai-telegram" style="padding:8px 10px;background:#f1f3f4;color:#1a73e8;border:1px solid #dadce0;border-radius:6px;cursor:pointer">Telegram</button>
                <button id="gv-ai-log-niis" style="padding:8px 10px;background:#e8f0fe;color:#1967d2;border:1px solid #d2e3fc;border-radius:6px;cursor:pointer" title="Log a confirmed SMS in NIIS">Log NIIS</button>
            </div>
        `;
        document.body.appendChild(widget);

        const status = widget.querySelector('#gv-copilot-status');
        const detail = widget.querySelector('#gv-copilot-detail');
        const draftButton = widget.querySelector('#gv-ai-draft');
        const telegramButton = widget.querySelector('#gv-ai-telegram');
        const logButton = widget.querySelector('#gv-ai-log-niis');

        async function createDraft() {
            const field = getMessageInputField();
            if (!field) throw new Error('Open a Google Voice conversation and wait for its message box to load.');
            const client = getActiveClientDetails();

            status.textContent = 'Checking calendar...';
            const messages = getActiveThreadMessages();
            const clientMessage = messages.at(-1) || 'The client is asking to schedule an inspection.';
            const slots = await getAvailableInspectionSlots();

            status.textContent = 'Generating reply...';
            const reply = await generateAIReply(clientMessage, slots);
            if (!field.isConnected || normalizePhone(getActiveClientDetails().phone) !== normalizePhone(client.phone)) {
                throw new Error('The active conversation changed while the reply was being generated. Try again.');
            }
            status.textContent = 'Typing draft...';
            await humanTypeIntoField(field, reply);
            detail.textContent = `Draft ready. Available times: ${slots}`;
            status.textContent = 'Draft ready';
            return { reply, clientMessage, client, field };
        }

        draftButton.addEventListener('click', async () => {
            draftButton.disabled = true;
            try {
                await createDraft();
            } catch (error) {
                console.error('[GV-AI] Could not create a draft:', error);
                status.textContent = 'Error';
                detail.textContent = error.message;
            } finally {
                draftButton.disabled = false;
            }
        });

        telegramButton.addEventListener('click', async () => {
            telegramButton.disabled = true;
            try {
                const { reply, clientMessage, client, field } = await createDraft();
                if (!AI_CONFIG.telegramToken || !AI_CONFIG.telegramChatId) {
                    throw new Error('Configure Telegram credentials from the Tampermonkey menu first.');
                }
                if (!normalizePhone(client.phone)) {
                    throw new Error('Could not identify the client phone number for Telegram approval.');
                }

                const callbackId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
                status.textContent = 'Sending Telegram approval...';
                await sendTelegramApprovalRequest(client, clientMessage, reply, callbackId);
                status.textContent = 'Waiting for approval...';
                detail.textContent = 'Approve or reject the draft from Telegram.';
                const decision = await pollTelegramDecision(callbackId);

                if (decision === 'rejected') {
                    status.textContent = 'Rejected';
                    detail.textContent = 'Telegram draft was rejected.';
                    return;
                }
                if (decision === 'timeout') {
                    status.textContent = 'Timed out';
                    detail.textContent = 'No Telegram decision was received.';
                    return;
                }

                status.textContent = 'Approved; sending...';
                if (!field.isConnected || normalizePhone(getActiveClientDetails().phone) !== normalizePhone(client.phone)) {
                    throw new Error('The active conversation changed while awaiting approval. The approved reply was not sent.');
                }
                await humanTypeIntoField(field, reply);
                await new Promise(resolve => setTimeout(resolve, 800));
                if (!field.isConnected || normalizePhone(getActiveClientDetails().phone) !== normalizePhone(client.phone)) {
                    throw new Error('The active conversation changed before sending. The reply remains unsent.');
                }
                const sendButton = document.querySelector(
                    'button[aria-label*="Send message" i], button[mattooltip*="Send" i], .send-button, gv-icon-button[aria-label*="Send" i]'
                );
                if (!sendButton || sendButton.disabled) {
                    status.textContent = 'Draft ready';
                    detail.textContent = 'Approved draft is in the message box. Send it manually; NIIS was not updated.';
                    return;
                }

                sendButton.click();
                broadcastAIAttemptToNIIS({
                    phone: client.phone,
                    clientName: client.name,
                    draftText: reply
                });
                status.textContent = 'Sent';
                detail.textContent = 'SMS sent. Requested NIIS logging for the matching order.';
            } catch (error) {
                console.error('[GV-AI] Telegram approval flow failed:', error);
                status.textContent = 'Error';
                detail.textContent = error.message;
            } finally {
                telegramButton.disabled = false;
            }
        });

        logButton.addEventListener('click', () => {
            const client = getActiveClientDetails();
            if (client.phone === 'Unknown Phone') {
                alert('Could not identify the active conversation phone number.');
                return;
            }
            if (!confirm(`Log a confirmed SMS for ${client.name} (${client.phone}) in NIIS?`)) return;
            broadcastAIAttemptToNIIS({
                phone: client.phone,
                clientName: client.name,
                draftText: 'SMS confirmed manually in Google Voice'
            });
            status.textContent = 'NIIS sync requested';
            detail.textContent = 'The open NIIS page will log this only if exactly one matching order is found.';
        });
    }

    // =========================================================================
    // SECTION 2: GOOGLE VOICE SENDER LOGIC (voice.google.com)
    // =========================================================================
    if (currentUrl.includes('voice.google.com')) {

        let isRunning = false;
        let skipRequested = false;

        const container = document.createElement('div');
        container.style.cssText = 'position:fixed; bottom:20px; right:20px; z-index:9999; display:flex; gap:10px;';

        const btn = document.createElement('button');
        btn.textContent = 'Start Auto-Sending Texts';
        btn.style.cssText = 'padding:12px 18px; background:#1a73e8; color:white; border:none; border-radius:24px; cursor:pointer; font-weight:bold; box-shadow: 0 4px 6px rgba(0,0,0,0.2);';

        const manageBtn = document.createElement('button');
        manageBtn.textContent = 'Manage Queue';
        manageBtn.style.cssText = 'padding:12px 14px; background:#17a2b8; color:white; border:none; border-radius:24px; cursor:pointer; font-weight:bold; box-shadow: 0 4px 6px rgba(0,0,0,0.2);';

        const skipBtn = document.createElement('button');
        skipBtn.textContent = 'Skip Current';
        skipBtn.style.cssText = 'padding:12px 14px; background:#fd7e14; color:white; border:none; border-radius:24px; cursor:pointer; font-weight:bold; box-shadow: 0 4px 6px rgba(0,0,0,0.2);';

        const clearBtn = document.createElement('button');
        clearBtn.textContent = 'Clear Queue';
        clearBtn.style.cssText = 'padding:12px 14px; background:#dc3545; color:white; border:none; border-radius:24px; cursor:pointer; font-weight:bold; box-shadow: 0 4px 6px rgba(0,0,0,0.2);';

        container.appendChild(btn);
        container.appendChild(manageBtn);
        container.appendChild(skipBtn);
        container.appendChild(clearBtn);
        document.body.appendChild(container);
        injectAICopilotWidget();

        manageBtn.addEventListener('click', renderQueueModal);

        const sleep = (ms) => new Promise(r => setTimeout(r, ms));

        function setInputValue(element, text) {
            element.focus();
            element.click();

            const proto = (element instanceof HTMLTextAreaElement)
                ? window.HTMLTextAreaElement.prototype
                : window.HTMLInputElement.prototype;

            const valueSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;

            if (valueSetter) {
                valueSetter.call(element, text);
            } else {
                element.value = text;
            }

            element.dispatchEvent(new Event('input', { bubbles: true }));
            element.dispatchEvent(new Event('change', { bubbles: true }));
        }

        skipBtn.addEventListener('click', () => {
            let queue = GM_getValue('gv_sms_queue', []);
            if (!queue || queue.length === 0) {
                alert('Queue is empty!');
                return;
            }

            const skippedItem = queue[0];
            if (isRunning) {
                skipRequested = true;
                console.log(`⏭️ Skip requested for Order ${skippedItem.orderId} (${skippedItem.phone})`);
            } else {
                queue.shift();
                GM_setValue('gv_sms_queue', queue);
                alert(`Skipped order ${skippedItem.orderId} (${skippedItem.phone}). ${queue.length} remaining in queue.`);
            }
        });

        clearBtn.addEventListener('click', () => {
            if (confirm('Are you sure you want to clear the entire text queue?')) {
                GM_setValue('gv_sms_queue', []);
                alert('Queue cleared!');
            }
        });

        btn.addEventListener('click', async () => {
            if (isRunning) {
                isRunning = false;
                btn.textContent = 'Stopping...';
                btn.style.background = '#6c757d';
                return;
            }

            let queue = GM_getValue('gv_sms_queue', []);

            if (!queue || queue.length === 0) {
                alert('Queue is empty! Queue up messages on the NIIS tab first.');
                return;
            }

            isRunning = true;
            btn.style.background = '#ffc107';
            btn.style.color = '#000';

            while (queue.length > 0 && isRunning) {
                skipRequested = false;
                const currentItem = queue[0];
                btn.textContent = `Stop (${queue.length} left) - Sending to ${currentItem.phone}...`;

                try {
                    const sendMsgBtn = document.querySelector('.threads-button[aria-label="Send new message"]')
                                    || document.querySelector('.threads-button');

                    if (sendMsgBtn) {
                        sendMsgBtn.click();
                        await sleep(1500);
                    }

                    if (!isRunning || skipRequested) {
                        if (skipRequested) {
                            queue.shift();
                            GM_setValue('gv_sms_queue', queue);
                            continue;
                        }
                        break;
                    }

                    const recipientInput = document.querySelector('input[placeholder*="Type a name or phone number"]')
                                        || document.querySelector('input[aria-label*="Type a name or phone number"]')
                                        || document.querySelectorAll('input[type="text"]:not(.gb_He)')[0];

                    if (recipientInput) {
                        setInputValue(recipientInput, currentItem.phone);
                        await sleep(1000);

                        recipientInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, code: 'Enter', bubbles: true }));
                        await sleep(1000);

                        const dropdownOption = document.querySelector('mat-option, [role="option"], .send-to-button, .contact-label-item');
                        if (dropdownOption) {
                            dropdownOption.click();
                            await sleep(1200);
                        }
                    }

                    if (!isRunning || skipRequested) {
                        if (skipRequested) {
                            queue.shift();
                            GM_setValue('gv_sms_queue', queue);
                            continue;
                        }
                        break;
                    }

                    const messageBox = document.querySelector('textarea[aria-label*="Type a message"]')
                                    || document.querySelector('textarea#user-input')
                                    || document.querySelector('textarea');

                    if (messageBox) {
                        setInputValue(messageBox, currentItem.message);
                        await sleep(1200);

                        if (skipRequested) {
                            queue.shift();
                            GM_setValue('gv_sms_queue', queue);
                            continue;
                        }

                        const sendBtn = document.querySelector('button[aria-label*="Send message"]')
                                     || document.querySelector('button[mattooltip*="Send"]')
                                     || document.querySelector('.send-button')
                                     || document.querySelector('mat-icon[data-mat-icon-type="font"][aria-label*="send"]')?.closest('button');

                        let sentSuccessfully = false;
                        if (sendBtn && !sendBtn.disabled) {
                            sendBtn.click();
                            sentSuccessfully = true;
                        } else {
                            messageBox.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, code: 'Enter', bubbles: true }));
                            sentSuccessfully = true;
                        }

                        if (sentSuccessfully) {
                            console.log(`✅ Successfully sent SMS to ${currentItem.phone}. Logging to NIIS now...`);
                            await logToNIIS(currentItem.orderId, currentItem.clientId, 'Left message.');
                        }
                    }

                    queue.shift();
                    GM_setValue('gv_sms_queue', queue);

                } catch (err) {
                    console.error(`❌ Error processing ${currentItem.phone}:`, err);
                    break;
                }

                const totalDelaySeconds = Math.floor(Math.random() * 11) + 15;

                for (let remaining = totalDelaySeconds; remaining > 0; remaining--) {
                    if (!isRunning || skipRequested) break;
                    btn.textContent = `Pause (${queue.length} left) - Next send in ${remaining}s...`;
                    await sleep(1000);
                }

                if (skipRequested) {
                    console.log(`⏭️ Fast-forwarding to next item...`);
                }
            }

            isRunning = false;
            btn.textContent = queue.length === 0 ? 'Queue Finished!' : 'Resume Auto-Sending';
            btn.style.background = '#1a73e8';
            btn.style.color = '#fff';
        });
    }

})();