// ==UserScript==
// @name         NIIS Automation (GV SMS + Slybroadcast Voicemails)
// @namespace    http://tampermonkey.net/
// @version      5.2
// @description  Parses NIIS orders, generates line-separated Slybroadcast phone lists to clipboard, sends GV messages, and logs activity back to NIIS.
// @match        https://nationalis.com/ssecure/browser/inspector.cfm*
// @match        https://nationalis.com/ssecure/index.cfm*
// @match        https://voice.google.com/*
// @connect      nationalis.com
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// ==/UserScript==

(function() {
    'use strict';

    const currentUrl = window.location.href;

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
        let queue = GM_getValue('gv_sms_queue', []);

        if (queue.length === 0) {
            listContainer.innerHTML = '<p style="text-align: center; color: #6c757d; font-size: 16px; padding: 20px;">The queue is currently empty.</p>';
        } else {
            listContainer.innerHTML = queue.map((item, index) => `
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

                    const newAddress = prompt("Edit Property Address:", item.location);
                    if (newAddress === null) return;

                    const newMessage = prompt("Edit Message Text:", item.message);
                    if (newMessage === null) return;

                    currentQueue[idx].phone = newPhone.trim();
                    currentQueue[idx].location = newAddress.trim();
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
                            queue.push({ phone, message: textBody, orderId, clientId, location: formattedAddress });
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