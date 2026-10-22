import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import { createServer } from "vite-plus";

const root = resolve(import.meta.dirname, "../..");
const cacheDir = await mkdtemp(resolve(root, ".question-probe-"));
// The harness stands in for the composer: a text box whose send action
// answers the pending question, as ChatComposer routes it.
const harness = `import '/src/styles.css';import React from 'react';import{createRoot}from'react-dom/client';
import{QuestionTray,useQuestionAnswer}from'/src/components/composer/question-tray.tsx';
import{composerTraySurfaceClass}from'/src/components/composer/tray-pill.tsx';
const h=React.createElement;
window.answers=[];window.cancellations=[];window.failAnswer=false;let version=0;
function Harness(props){
 const answer=useQuestionAnswer(props);const[text,setText]=React.useState('');
 const ready=answer!==null&&answer.canAnswer(text.trim().length>0);
 const send=()=>{if(!ready)return;const sent=text;void answer.answer(sent).then(consumed=>{if(consumed&&sent.trim())setText('')});};
 return h('div',{className:'relative'},
  answer?h('div',{className:composerTraySurfaceClass+' relative z-10 rounded-b-none rounded-t-[1.2rem]'},h(QuestionTray,{answer})):null,
  h('div',{className:'composer-glass rounded-[1.2rem] border border-border/50 bg-card shadow-overlay-sm'},
   h('div',{className:'flex items-end gap-2 px-3 pb-2 pt-3'},
    h('textarea',{'aria-label':'Composer',value:text,rows:2,placeholder:answer?'Type your own answer…':'Ask anything',onChange:e=>setText(e.target.value),onKeyDown:e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send();}},className:'flex-1 resize-none bg-transparent text-sm outline-none placeholder:text-muted-foreground/60'}),
    h('button',{type:'button','aria-label':answer&&!answer.last?'Continue':'Submit answer',disabled:!ready,onClick:send,className:'grid size-6 place-items-center rounded-full bg-primary text-primary-foreground disabled:opacity-40'},'↑'))));
}
const root=createRoot(document.getElementById('root'));let current;
window.updateQuestion=extra=>{current={...current,...extra};root.render(h(Harness,current));};
window.renderQuestion=(questions,extra={})=>{current={environmentId:'remote',sessionId:'session',itemId:'question-'+(++version),questions,...extra};window.updateQuestion({});};
window.renderQuestion([{question:'How should we validate this change?',options:['Run the focused checks (Recommended)','Run the full test suite','Review the changes first']}]);`;
const server = await createServer({
	root,
	configFile: resolve(root, "vite.config.ts"),
	cacheDir,
	server: {
		host: "127.0.0.1",
		port: 15833,
		strictPort: false,
		open: false,
		hmr: false,
		watch: null,
	},
	plugins: [
		{
			name: "question-probe",
			enforce: "pre",
			configureServer(server) {
				server.middlewares.use("/__questions", async (_req, res) => {
					res.setHeader("Content-Type", "text/html");
					res.end(
						await server.transformIndexHtml(
							"/__questions.html",
							'<html class="dark"><body style="padding:32px"><main style="max-width:760px;margin:auto"><div id="root"></div></main><script type="module" src="/@id/__x00__question-probe"></script></body></html>',
						),
					);
				});
			},
			resolveId(id, importer) {
				if (id === "\0question-probe") return id;
				if (
					importer?.includes("question-tray.tsx") &&
					id.endsWith("store/sessions.ts")
				)
					return "\0question-store";
			},
			load(id) {
				if (id === "\0question-store")
					return `export const useSessionsStore=selector=>selector({answerQuestion:async(...args)=>{window.answers.push(args);if(window.failAnswer)throw new Error('Rejected');},cancelQuestion:async(...args)=>{window.cancellations.push(args);}});`;
				if (id === "\0question-probe") return harness;
			},
		},
	],
});
let browser;
try {
	await server.listen();
	browser = await chromium.launch({
		headless: true,
		executablePath: process.env.CHROME_BIN,
	});
	const page = await browser.newPage({
		viewport: { width: 900, height: 540 },
		deviceScaleFactor: 2,
	});
	const errors = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto(
		`http://127.0.0.1:${server.httpServer.address().port}/__questions`,
	);
	const composer = page.getByRole("textbox", { name: "Composer" });
	const answers = () => page.evaluate(() => window.answers);
	const waitForAnswers = (count) =>
		page.waitForFunction((n) => window.answers.length === n, count);

	await page.getByText("How should we validate this change?").waitFor();
	assert.equal(
		await page.getByRole("button", { name: "Submit answer" }).isDisabled(),
		true,
	);
	await page.locator("#root").screenshot({
		path: resolve(root, "../../.context/question-ui.png"),
	});

	// A single-select pick answers in one click.
	await page.getByRole("button", { name: /Run the full test suite/ }).click();
	await waitForAnswers(1);
	assert.deepEqual((await answers())[0][3], [
		{ questionIndex: 0, selected: [1] },
	]);

	// The composer text is the free-text answer and clears once sent.
	await page.evaluate(() =>
		window.renderQuestion([{ question: "Where?", options: ["Prod", "Dev"] }]),
	);
	await composer.fill("Use staging");
	await composer.press("Enter");
	await waitForAnswers(2);
	assert.deepEqual((await answers())[1][3], [
		{ questionIndex: 0, selected: [], other: "Use staging" },
	]);
	assert.equal(await composer.inputValue(), "");

	// Multi-select drafts survive paging; send continues to the next question.
	await page.evaluate(() =>
		window.renderQuestion([
			{
				question: "Which checks?",
				options: ["Types", "Tests", "Lint"],
				multiSelect: true,
			},
			{ question: "When?", options: ["Now", "Later"] },
		]),
	);
	await page.getByRole("button", { name: "Types", exact: true }).click();
	await page.getByRole("button", { name: "Tests", exact: true }).click();
	await page.getByRole("button", { name: "Continue", exact: true }).click();
	await page.getByText("When?").waitFor();
	await page.getByRole("button", { name: "Previous question" }).click();
	assert.equal(
		await page
			.getByRole("button", { name: "Types", exact: true })
			.getAttribute("aria-pressed"),
		"true",
	);
	await page.getByRole("button", { name: "Next question" }).click();
	await page.getByRole("button", { name: /Now/ }).click();
	await waitForAnswers(3);
	assert.deepEqual((await answers())[2][3], [
		{ questionIndex: 0, selected: [0, 1] },
		{ questionIndex: 1, selected: [0] },
	]);

	// Number keys pick outside text fields and type normally inside them.
	await page.evaluate(() =>
		window.renderQuestion([{ question: "Ship it?", options: ["Yes", "No"] }]),
	);
	await composer.focus();
	await page.keyboard.press("1");
	assert.equal(await composer.inputValue(), "1");
	await composer.fill("");
	await page.locator("body").click({ position: { x: 4, y: 4 } });
	await page.keyboard.press("2");
	await waitForAnswers(4);
	assert.deepEqual((await answers())[3][3], [
		{ questionIndex: 0, selected: [1] },
	]);

	// A rejected answer unlocks the tray for retry.
	await page.evaluate(() => {
		window.failAnswer = true;
		window.renderQuestion([
			{ question: "Confirm?", options: ["Proceed", "Wait"] },
		]);
	});
	await page.getByRole("button", { name: /Proceed/ }).click();
	await waitForAnswers(5);
	await page.waitForFunction(
		() =>
			!document
				.querySelector("[data-question-option]")
				?.hasAttribute("disabled"),
	);
	await page.evaluate(() => {
		window.failAnswer = false;
		window.updateQuestion({
			submission: "failed",
			submissionError: "Connection lost",
		});
	});
	assert.match(await page.getByRole("alert").innerText(), /Connection lost/);
	await page.getByRole("button", { name: /Proceed/ }).click();
	await waitForAnswers(6);

	// Detached questions cannot be answered but can be dismissed.
	await page.evaluate(() =>
		window.renderQuestion([{ question: "Later?", options: ["Yes"] }], {
			disabled: true,
		}),
	);
	await page.getByText("Reconnecting to this question…").waitFor();
	assert.equal(
		await page.getByRole("button", { name: /Yes/ }).isDisabled(),
		true,
	);
	await page.getByRole("button", { name: "Dismiss", exact: true }).click();
	await page.waitForFunction(() => window.cancellations.length === 1);

	await page.evaluate(() =>
		window.renderQuestion([{ question: "Expired?", options: ["Yes"] }], {
			expired: true,
		}),
	);
	assert.equal(
		await page
			.getByRole("button", { name: "Dismiss", exact: true })
			.isDisabled(),
		true,
	);
	assert.deepEqual(errors, []);
	console.log(
		"Question picks, composer answers, paging, shortcuts, retry, and expiry passed.",
	);
} finally {
	await browser?.close();
	await server.close();
	await rm(cacheDir, { recursive: true, force: true });
}
