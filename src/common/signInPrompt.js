// Browsers only allow popups opened directly from a click, while authentication can be triggered at any time (e.g. by a
//   request that turns out to need credentials). When the popup is blocked, we ask the user to click through this prompt,
//   which opens the popup from their click. It lives in a closed shadow root, so the host page's styles don't affect it.
// Note that the prompt never collects credentials: signing in always happens in the Redivis window, where the user can
//   see the address bar.

const styles = `
	:host {
		all: initial;
	}
	dialog {
		box-sizing: border-box;
		width: min(400px, calc(100vw - 32px));
		padding: 24px;
		border: 1px solid #e3e3e3;
		border-radius: 8px;
		background: #ffffff;
		color: #1f1f1f;
		font: 14px/1.5 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
		box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
	}
	dialog::backdrop {
		background: rgba(0, 0, 0, 0.4);
	}
	h2 {
		margin: 0 0 8px;
		font-size: 18px;
		font-weight: 600;
	}
	p {
		margin: 0 0 16px;
	}
	.error {
		color: #b3261e;
	}
	.buttons {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
	}
	/* Buttons mirror the Redivis app's (NewButton) primary and secondary styles */
	button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		height: 29px;
		padding: 5px 10px;
		border: 1px solid transparent;
		border-radius: 2px;
		font: 600 14px/19px 'Nunito Sans', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
		white-space: nowrap;
		cursor: pointer;
	}
	button.sign-in {
		color: #ffffff;
		background: #7f3b97;
		border-color: #7f3b97;
		box-shadow: 0 2px 4px 0 rgba(0, 0, 0, 0.2);
	}
	button.sign-in:hover {
		box-shadow: 0 3px 6px 0 rgba(0, 0, 0, 0.2);
	}
	button.sign-in:active {
		box-shadow: inset 2px 2px 3px #5e1e75;
	}
	button.cancel {
		color: #2f2e33;
		background: #ffffff;
		border-color: #ffffff;
		box-shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.2);
	}
	button.cancel:hover {
		box-shadow: 0 2px 4px 0 rgba(0, 0, 0, 0.2);
	}
	button.cancel:active {
		box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.2);
	}
	button:focus-visible {
		outline: -webkit-focus-ring-color auto 1px;
	}
	@media (prefers-color-scheme: dark) {
		dialog {
			border-color: #3a3a3a;
			background: #1f1f1f;
			color: #f2f2f2;
		}
		.error {
			color: #f2b8b5;
		}
		button.cancel {
			color: #f2f2f2;
			background: #2f2e33;
			border-color: #2f2e33;
			box-shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.6);
		}
	}
`;

// onSignIn is called synchronously from the click, and returns whether the popup opened. onCancel is called if the user
//   dismisses the prompt instead. An optional notice explains why the prompt is shown (e.g. the popup was closed).
//   Returns a function that removes the prompt without cancelling, e.g. once signing in completes some other way.
export function showSignInPrompt({ notice, onSignIn, onCancel }) {
	const host = document.createElement('redivis-sign-in-prompt');
	const shadowRoot = host.attachShadow({ mode: 'closed' });
	shadowRoot.innerHTML = `
		<style>${styles}</style>
		<dialog aria-labelledby="title" aria-describedby="description">
			<h2 id="title">Sign in to Redivis</h2>
			<p id="description">This page needs access to your Redivis account to continue.</p>
			<p class="notice" hidden></p>
			<p class="error" role="alert" hidden>
				Your browser blocked the sign-in window. Allow popups for this site, then try again.
			</p>
			<div class="buttons">
				<button type="button" class="cancel">Cancel</button>
				<button type="button" class="sign-in">Sign in with Redivis</button>
			</div>
		</dialog>
	`;
	const dialog = shadowRoot.querySelector('dialog');
	const signInButton = shadowRoot.querySelector('.sign-in');
	const noticeElement = shadowRoot.querySelector('.notice');
	const errorElement = shadowRoot.querySelector('.error');
	let shouldCancelOnClose = true;

	if (notice) {
		noticeElement.textContent = notice;
		noticeElement.hidden = false;
	}

	function remove() {
		shouldCancelOnClose = false;
		dialog.close();
		host.remove();
	}

	signInButton.addEventListener('click', () => {
		if (onSignIn()) {
			remove();
		} else {
			noticeElement.hidden = true;
			errorElement.hidden = false;
		}
	});
	shadowRoot.querySelector('.cancel').addEventListener('click', () => dialog.close());
	// Fires however the dialog is closed, including with the escape key
	dialog.addEventListener('close', () => {
		host.remove();
		if (shouldCancelOnClose) {
			onCancel();
		}
	});

	(document.body || document.documentElement).append(host);
	// A modal dialog is drawn in the top layer, above anything on the page regardless of z-index
	dialog.showModal();
	signInButton.focus();

	return remove;
}
