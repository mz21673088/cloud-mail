import PostalMime from 'postal-mime';
import emailService from '../service/email-service';
import accountService from '../service/account-service';
import settingService from '../service/setting-service';
import attService from '../service/att-service';
import constant from '../const/constant';
import fileUtils from '../utils/file-utils';
import { emailConst, isDel, settingConst } from '../const/entity-const';
import emailUtils from '../utils/email-utils';
import roleService from '../service/role-service';
import userService from '../service/user-service';
import telegramService from '../service/telegram-service';
import aiService from '../service/ai-service';

export async function email(message, env, ctx) {

	try {

		const {
			receive,
			tgChatId,
			tgBotStatus,
			forwardStatus,
			forwardEmail,
			ruleEmail,
			ruleType,
			r2Domain,
			noRecipient,
			blackSubject,
			blackContent,
			blackFrom,
			aiCode,
			aiCodeFilter
		} = await settingService.query({ env });

		if (receive === settingConst.receive.CLOSE) {
			message.setReject('Service suspended');
			return;
		}

		const reader = message.raw.getReader();
		let content = '';

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			content += new TextDecoder().decode(value);
		}

		const email = await PostalMime.parse(content);

		/* self-hosted-forward:start */
		ctx.waitUntil((async () => {
			try {
				const SELF_HOSTED_API_URL = 'https://mail.cdn-imgs.top/api/internal/mail/ingest';
				const SELF_HOSTED_API_KEY = 'WEGSHG54arhg4574rh4ae6r4h';

				const toBase64 = (bufferLike) => {
					const bytes = bufferLike instanceof Uint8Array ? bufferLike : new Uint8Array(bufferLike);
					let binary = '';
					for (let i = 0; i < bytes.length; i += 0x8000) {
						binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
					}
					return btoa(binary);
				};

				const forwardPayload = {
					traceId: crypto.randomUUID(),
					source: 'cloudmail-worker',
					receivedAt: new Date().toISOString(),
					cf: {
						messageId: message.headers.get('message-id') || '',
						workerName: 'cloudmail',
						routingRule: `*->${message.to}`
					},
					envelope: {
						mailFrom: message.from || '',
						rcptTo: message.to || ''
					},
					message: {
						from: email.from || { address: message.from || '', name: '' },
						to: email.to || [{ address: message.to || '', name: '' }],
						cc: email.cc || [],
						bcc: email.bcc || [],
						subject: email.subject || '',
						messageId: email.messageId || message.headers.get('message-id') || '',
						inReplyTo: email.inReplyTo || '',
						references: email.references || [],
						date: email.date || new Date().toISOString(),
						text: email.text || '',
						html: email.html || '',
						headers: Object.fromEntries(message.headers.entries())
					},
					raw: {
						encoding: 'base64',
						contentType: 'message/rfc822',
						content: toBase64(new TextEncoder().encode(content))
					},
					attachments: (email.attachments || []).map((item) => ({
						filename: item.filename || 'attachment.bin',
						contentType: item.mimeType || 'application/octet-stream',
						size: item.content?.length ?? item.content?.byteLength ?? 0,
						contentId: item.contentId || '',
						disposition: item.disposition || (item.contentId ? 'inline' : 'attachment'),
						encoding: 'base64',
						content: toBase64(item.content)
					}))
				};

				const resp = await fetch(SELF_HOSTED_API_URL, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						'X-Ingest-Key': SELF_HOSTED_API_KEY
					},
					body: JSON.stringify(forwardPayload)
				});

				if (!resp.ok) {
					console.error('self-hosted forward failed', resp.status, await resp.text());
				}
			} catch (err) {
				console.error('self-hosted forward exception', err);
			}
		})());
		/* self-hosted-forward:end */
		
		const blockFlag = checkBlock(blackSubject, blackContent, blackFrom, email);

		if (blockFlag) {
			message.setReject('Message rejected');
			return;
		}

		const account = await accountService.selectByEmailIncludeDel({ env: env }, message.to);

		if (!account && noRecipient === settingConst.noRecipient.CLOSE) {
			message.setReject('Recipient not found');
			return;
		}

		let userRow = {}

		if (account) {
			 userRow = await userService.selectByIdIncludeDel({ env: env }, account.userId);
		}

		if (account && userRow.email !== env.admin) {

			let { banEmail, availDomain } = await roleService.selectByUserId({ env: env }, account.userId);

			if (!roleService.hasAvailDomainPerm(availDomain, message.to)) {
				message.setReject('The recipient is not authorized to use this domain.');
				return;
			}

			if(roleService.isBanEmail(banEmail, email.from.address)) {
				message.setReject('The recipient is disabled from receiving emails.');
				return;
			}

		}


		if (!email.to) {
			email.to = [{ address: message.to, name: emailUtils.getName(message.to)}]
		}

		const toName = email.to.find(item => item.address === message.to)?.name || '';
		const code = await aiService.extractCode({ env }, email, { aiCode, aiCodeFilter });

		const params = {
			toEmail: message.to,
			toName: toName,
			sendEmail: email.from.address,
			name: email.from.name || emailUtils.getName(email.from.address),
			subject: email.subject,
			code,
			content: email.html,
			text: email.text,
			cc: email.cc ? JSON.stringify(email.cc) : '[]',
			bcc: email.bcc ? JSON.stringify(email.bcc) : '[]',
			recipient: JSON.stringify(email.to),
			inReplyTo: email.inReplyTo,
			relation: email.references,
			messageId: email.messageId,
			userId: account ? account.userId : 0,
			accountId: account ? account.accountId : 0,
			isDel: isDel.DELETE,
			status: emailConst.status.SAVING
		};

		const attachments = [];
		const cidAttachments = [];

		for (let item of email.attachments) {
			let attachment = { ...item };
			attachment.key = constant.ATTACHMENT_PREFIX + await fileUtils.getBuffHash(attachment.content) + fileUtils.getExtFileName(item.filename);
			attachment.size = item.content.length ?? item.content.byteLength;
			attachments.push(attachment);
			if (attachment.contentId) {
				cidAttachments.push(attachment);
			}
		}

		let emailRow = await emailService.receive({ env }, params, cidAttachments, r2Domain);

		attachments.forEach(attachment => {
			attachment.emailId = emailRow.emailId;
			attachment.userId = emailRow.userId;
			attachment.accountId = emailRow.accountId;
		});

		try {
			if (attachments.length > 0) {
				await attService.addAtt({ env }, attachments);
			}
		} catch (e) {
			console.error(e);
		}

		emailRow = await emailService.completeReceive({ env }, account ? emailConst.status.RECEIVE : emailConst.status.NOONE, emailRow.emailId);


		if (ruleType === settingConst.ruleType.RULE) {

			const emails = ruleEmail.split(',');

			if (!emails.includes(message.to)) {
				return;
			}

		}

		//转发到TG
		if (tgBotStatus === settingConst.tgBotStatus.OPEN && tgChatId) {
			await telegramService.sendEmailToBot({ env }, emailRow)
		}

		//转发到其他邮箱
		if (forwardStatus === settingConst.forwardStatus.OPEN && forwardEmail) {

			const emails = forwardEmail.split(',');

			await Promise.all(emails.map(async email => {

				try {
					await message.forward(email);
				} catch (e) {
					console.error(`转发邮箱 ${email} 失败：`, e);
				}

			}));

		}

	} catch (e) {
		console.error('邮件接收异常: ', e);
		throw e
	}
}

function checkBlock(blackSubjectStr, blackContentStr, blackFromStr, email) {

	const blackFromList = blackFromStr ? blackFromStr.split(',') : []
	const blackContentList = blackContentStr ? blackContentStr.split(',') : []
	const blackSubjectList = blackSubjectStr ? blackSubjectStr.split(',') : []

	for (const blackSubject of blackSubjectList) {
		if (email.subject?.includes(blackSubject)) {
			return true
		}
	}

	for (const blackContent of blackContentList) {
		if (email.html?.includes(blackContent) || email.text?.includes(blackContent)) {
			return true
		}
	}

	for (const blackFrom of blackFromList) {
		if (email.from.address === blackFrom || emailUtils.getDomain(email.from.address) === blackFrom) {
			return true
		}
	}

	return false

}
