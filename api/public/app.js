// Helpers shared by index.html and drawers.html. Page-specific logic stays
// inline in each page; only what both need lives here.

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function setStatus(element, message, type = '') {
    element.textContent = message;
    element.className = `status ${type}`.trim();
}

// The dot in the top bar is the only always-visible sign the API is alive,
// so a failed fetch has to show as offline rather than only in the console.
function startHealthIndicator() {
    const dot = document.getElementById('healthDot');
    const label = document.getElementById('healthLabel');

    if (!dot || !label) {
        return;
    }

    fetch('/health')
        .then((response) => {
            if (!response.ok) {
                throw new Error('unhealthy');
            }
            dot.className = 'health-dot online';
            label.textContent = 'API online';
        })
        .catch(() => {
            dot.className = 'health-dot offline';
            label.textContent = 'API unreachable';
        });
}
