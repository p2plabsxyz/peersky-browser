/**
 * Handles display of various error types (HTTP, network, protocol)
 */

(function () {
    'use strict';

    // Error code mappings
    const ERROR_MESSAGES = {
        // HTTP Status Codes
        '400': 'Bad Request',
        '401': 'Unauthorized',
        '403': 'Access Forbidden',
        '404': 'Page Not Found',
        '408': 'Request Timeout',
        '500': 'Internal Server Error',
        '502': 'Bad Gateway',
        '503': 'Service Unavailable',
        // Chromium Network Error Codes
        '-2': 'Failed to Load',
        '-7': 'Timed Out',
        '-102': 'Connection Refused',
        '-104': 'Connection Failed',
        '-105': 'Name Not Resolved',
        '-106': 'Internet Disconnected',
        '-107': 'SSL Protocol Error',
        '-118': 'Connection Timed Out',
        '-200': 'Certificate Error',
        '-310': 'Too Many Redirects',
        '-324': 'Empty Response'
    };

    const ERROR_EXPLANATIONS = {
        '403': 'You don\'t have permission to access this resource.',
        '404': 'The page you\'re looking for doesn\'t exist or has been moved.',
        '500': 'The server encountered an error. Please try again later.',
        '-102': 'The server refused the connection. It might be down or blocking requests.',
        '-105': 'Could not find the server. Check the URL or your internet connection.',
        '-106': 'Your internet connection appears to be offline.',
        '-118': 'The connection attempt timed out. The server might be slow or unreachable.',
        '-200': 'There\'s a problem with the website\'s security certificate.'
    };

    const ERROR_ICONS = {
        '404': '🔍',
        '403': '🚫',
        '-105': '🌐',
        '-106': '🌐',
        '-7': '⏱️',
        '-118': '⏱️'
    };

    /**
     * Get error icon based on code
     */
    function getErrorIcon(code) {
        const codeStr = String(code);

        if (ERROR_ICONS[codeStr]) return ERROR_ICONS[codeStr];
        if (codeStr.startsWith('-20')) return '🔒'; // Certificate errors
        if (codeStr.startsWith('-10')) return '🔌'; // Connection errors

        return '⚠️'; // Default
    }

    /**
     * Display error on page
     */
    function displayError() {
        const params = new URLSearchParams(window.location.search);
        const errorCode = params.get('code') || 'Unknown';
        const customMessage = params.get('msg') || '';
        const failedUrl = params.get('url') || '';

        // Update icon
        document.getElementById('errorIcon').textContent = getErrorIcon(errorCode);

        // Update error code
        document.getElementById('errorCode').textContent =
            errorCode === 'Unknown' ? 'Error' : `Error ${errorCode}`;

        // Update message
        const friendlyMessage = ERROR_MESSAGES[errorCode] || 'Network Error';
        document.getElementById('errorMessage').textContent =
            customMessage || friendlyMessage;

        // Update explanation
        const explanation = ERROR_EXPLANATIONS[errorCode] ||
            'An unexpected error occurred while loading this page.';
        document.getElementById('errorExplanation').textContent = explanation;

        // Update failed URL if present
        if (failedUrl) {
            document.getElementById('errorUrl').textContent = decodeURIComponent(failedUrl);
        }

        // Update page title
        document.title = `${friendlyMessage} - Peersky Browser`;
    }

    // Initialize
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', displayError);
    } else {
        displayError();
    }
})();