const chatForm = document.querySelector('#chat-form');
const chatInput = document.querySelector('#chat-message');
const sendButton = document.querySelector('#chat-send');
const chatMessages = document.querySelector('#chat-messages');
const chatStatus = document.querySelector('#chat-status');

const greeting = 'Hi there! How can I help you today?';
const defaultStatus = 'Orders are saved locally only after final confirmation. No payment is processed.';
const conversationHistory = [{ role: 'assistant', content: greeting }];
let requestInProgress = false;

function addMessage(role, content, className = '') {
  const message = document.createElement('div');
  message.className = `message ${role === 'user' ? 'user-message' : 'bot-message'} ${className}`.trim();
  message.textContent = content;
  chatMessages.append(message);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return message;
}

function updateSendButton() {
  sendButton.disabled = requestInProgress || chatInput.value.trim() === '';
}

chatInput.addEventListener('input', () => {
  chatInput.style.height = 'auto';
  chatInput.style.height = `${Math.min(chatInput.scrollHeight, 110)}px`;
  updateSendButton();
});

chatInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    chatForm.requestSubmit();
  }
});

chatForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (requestInProgress) return;

  const message = chatInput.value.trim();
  if (!message) {
    updateSendButton();
    return;
  }

  requestInProgress = true;
  updateSendButton();
  chatInput.value = '';
  chatInput.style.height = 'auto';
  addMessage('user', message);
  const loadingMessage = addMessage('assistant', 'CafeBot is thinking…', 'message-loading');
  chatStatus.textContent = 'CafeBot is preparing a reply…';

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, conversationHistory }),
    });
    const data = await response.json();

    if (!response.ok) {
      const error = new Error(typeof data.reply === 'string' && data.reply.trim() ? data.reply : 'Chat request failed.');
      error.backendResponse = true;
      throw error;
    }
    if (typeof data.reply !== 'string' || data.reply.trim() === '') {
      throw new Error('Chat request failed.');
    }

    conversationHistory.push(
      { role: 'user', content: message },
      { role: 'assistant', content: data.reply },
    );
    if (conversationHistory.length > 20) {
      conversationHistory.splice(0, conversationHistory.length - 20);
    }
    loadingMessage.remove();
    addMessage('assistant', data.reply);
    chatStatus.textContent = defaultStatus;
  } catch (error) {
    loadingMessage.remove();
    addMessage('assistant', error?.backendResponse ? error.message : 'Sorry, I couldn’t get a reply just now. Please try again in a moment.', 'message-error');
    chatStatus.textContent = 'CafeBot could not reply just now.';
  } finally {
    requestInProgress = false;
    updateSendButton();
  }
});

updateSendButton();
