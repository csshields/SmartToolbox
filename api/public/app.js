// Helpers shared by every page in api/public. Page-specific logic stays
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
        .then(async (response) => {
            if (!response.ok) {
                throw new Error('unhealthy');
            }
            dot.className = 'health-dot online';
            label.textContent = 'API online';

            // A server with no box attached has its own database, so changes
            // made here never reach the toolbox. Say so on every page.
            const { local } = await response.json();

            if (local && !document.getElementById('localBadge')) {
                const badge = document.createElement('span');
                badge.id = 'localBadge';
                badge.className = 'local-badge';
                badge.textContent = 'Local copy';
                badge.title = 'This server is running on a development machine with its own database. Changes made here do not reach the toolbox - use the Pi\'s address for that.';
                dot.parentElement.prepend(badge);
            }
        })
        .catch(() => {
            dot.className = 'health-dot offline';
            label.textContent = 'API unreachable';
        });
}
