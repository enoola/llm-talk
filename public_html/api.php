<?php
declare(strict_types=1);

/**
 * llm-talk — a tiny shared message bus for multiple OpenCode instances.
 *
 * Single file, no dependencies, no database. Messages live in one flat JSON
 * file that lives OUTSIDE the web root so it can never be downloaded.
 *
 * Endpoints (all take ?action=...):
 *   GET  ?action=health              -> liveness + config sanity + store stats
 *   POST ?action=send                -> { to, text, kind?, thread? }   => { id }
 *   GET  ?action=inbox&to=NAME       -> messages for NAME, id > after
 *   GET  ?action=peers&to=NAME       -> known peers + unread counts
 *
 * Auth: send BUS_TOKEN as `X-Bus-Token`, `Authorization: Bearer <token>`,
 * or a `token` query/body field.
 *
 * Targets PHP 7.4+ so it runs anywhere on shared hosting.
 */

/* ============================== CONFIG ============================== */

// Change this to a long random string, e.g. `openssl rand -hex 32`.
const BUS_TOKEN = 'CHANGE_ME_TO_A_LONG_RANDOM_STRING';

// Absolute path to the JSON store. Leave empty to auto-detect a folder
// outside the web root (next to public_html). See bus_data_file().
const BUS_DATA_FILE = '';

// Housekeeping.
const BUS_MAX_MESSAGES = 2000; // oldest rows are pruned past this
const BUS_MAX_TEXT     = 8000; // characters per message
const BUS_MAX_THREAD   = 120;
const BUS_LOCK_WAIT    = 5;    // seconds to wait for the store lock

/* ============================= BOOTSTRAP ============================= */

function bus_fail(int $status, string $error, array $extra = array()): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode(array_merge(array('ok' => false, 'error' => $error), $extra));
    exit;
}

function bus_send_json(array $payload): void
{
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode($payload);
    exit;
}

/**
 * Walk up from this file looking for the web root directory Hostinger (or
 * Apache/nginx) actually serves.
 */
function bus_docroot()
{
    $names = array('public_html', 'www', 'htdocs', 'web', 'HTTP_ROOT');
    $dir   = __DIR__;
    for ($i = 0; $i < 6; $i++) {
        // Check the current directory before stepping up, so an api.php placed
        // directly in public_html/ is still recognised.
        if (in_array(basename($dir), $names, true)) {
            return $dir;
        }
        $parent = dirname($dir);
        if ($parent === $dir) {
            break;
        }
        $dir = $parent;
    }
    return '';
}

/**
 * Resolve the store path, and refuse to run if it would be web reachable.
 */
function bus_data_file(): string
{
    $file = BUS_DATA_FILE;
    if ($file === '') {
        $docroot = bus_docroot();
        $dir     = $docroot !== '' ? dirname($docroot) : dirname(__DIR__);
        $file    = $dir . DIRECTORY_SEPARATOR . 'llmtalk-data' . DIRECTORY_SEPARATOR . 'messages.json';
    }

    $dir = dirname($file);
    if (!is_dir($dir)) {
        if (!@mkdir($dir, 0700, true) && !is_dir($dir)) {
            bus_fail(500, 'Cannot create data directory: ' . $dir);
        }
    }

    $docroot = bus_docroot();
    $realDir = realpath($dir);
    $realWeb = $docroot !== '' ? realpath($docroot) : false;
    if ($realWeb !== false && $realDir !== false && strpos($realDir, $realWeb . DIRECTORY_SEPARATOR) === 0) {
        bus_fail(500, 'Data directory is inside the web root and would be publicly readable. '
            . 'Move BUS_DATA_FILE outside ' . $docroot . ' (for example ' . dirname($docroot) . '/llmtalk-data/messages.json).');
    }

    bus_lock_down($dir);
    return $dir . DIRECTORY_SEPARATOR . basename($file);
}

/** Drop deny-all rules next to the store, in case the folder is ever served. */
function bus_lock_down(string $dir): void
{
    $htaccess = "# created by llm-talk - the message store must never be served\n"
        . "<IfModule mod_authz_core.c>\nRequire all denied\n</IfModule>\n"
        . "<IfModule !mod_authz_core.c>\nOrder deny,allow\nDeny from all\n</IfModule>\n";
    $index = '';
    foreach (array('.htaccess' => $htaccess, 'index.html' => $index) as $name => $body) {
        $path = $dir . DIRECTORY_SEPARATOR . $name;
        if (!file_exists($path)) {
            @file_put_contents($path, $body);
        }
    }
}

function bus_lock(string $file)
{
    $path   = $file . '.lock';
    $handle = fopen($path, 'c');
    if ($handle === false) {
        bus_fail(500, 'Cannot open lock file next to the store.');
    }
    @chmod($path, 0600);
    if (!flock($handle, LOCK_EX)) {
        fclose($handle);
        bus_fail(503, 'Could not acquire the store lock.');
    }
    return $handle;
}

function bus_unlock($handle): void
{
    flock($handle, LOCK_UN);
    fclose($handle);
}

function bus_read(string $file): array
{
    if (!file_exists($file)) {
        return array('version' => 1, 'nextID' => 1, 'messages' => array());
    }
    $raw = @file_get_contents($file);
    if ($raw === false || trim($raw) === '') {
        return array('version' => 1, 'nextID' => 1, 'messages' => array());
    }
    $data = json_decode($raw, true);
    if (!is_array($data) || !isset($data['messages']) || !is_array($data['messages'])) {
        // Corrupt file: keep a copy so nothing is silently destroyed.
        @copy($file, $file . '.corrupt-' . time());
        bus_fail(500, 'Store file was unreadable; a .corrupt copy was kept. Reset it to start fresh.');
    }
    $data['version']  = isset($data['version']) ? $data['version'] : 1;
    $data['nextID']   = isset($data['nextID']) ? (int) $data['nextID'] : 1;
    $data['messages'] = array_values($data['messages']);
    return $data;
}

/** Atomic replace: temp file in the same directory, then rename. */
function bus_write(string $file, array $data): void
{
    $tmp = $file . '.tmp-' . getmypid();
    $json = json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    if ($json === false || @file_put_contents($tmp, $json, LOCK_EX) === false) {
        @unlink($tmp);
        bus_fail(500, 'Could not write the message store. Check permissions on ' . dirname($file) . '.');
    }
    @chmod($tmp, 0600);
    if (!@rename($tmp, $file)) {
        @unlink($tmp);
        bus_fail(500, 'Could not replace the message store.');
    }
}

/* ============================== INPUT ============================== */

function bus_param(string $name, string $default = '')
{
    static $body = null;
    if ($body === null) {
        $body = array();
        $raw  = file_get_contents('php://input');
        if (is_string($raw) && $raw !== '') {
            $decoded = json_decode($raw, true);
            if (is_array($decoded)) {
                $body = $decoded;
            } else {
                parse_str($raw, $body);
            }
        }
    }
    if (isset($_GET[$name])) {
        return is_string($_GET[$name]) ? $_GET[$name] : $default;
    }
    if (isset($_POST[$name])) {
        return is_string($_POST[$name]) ? $_POST[$name] : $default;
    }
    if (isset($body[$name]) && (is_string($body[$name]) || is_numeric($body[$name]))) {
        return (string) $body[$name];
    }
    return $default;
}

function bus_token(): string
{
    $header = '';
    if (function_exists('getallheaders')) {
        foreach (getallheaders() as $name => $value) {
            if (strtolower($name) === 'x-bus-token') {
                $header = (string) $value;
            }
        }
    }
    if ($header === '' && isset($_SERVER['HTTP_X_BUS_TOKEN'])) {
        $header = (string) $_SERVER['HTTP_X_BUS_TOKEN'];
    }
    if ($header === '' && isset($_SERVER['HTTP_AUTHORIZATION'])) {
        $auth = (string) $_SERVER['HTTP_AUTHORIZATION'];
        if (stripos($auth, 'bearer ') === 0) {
            $header = trim(substr($auth, 7));
        }
    }
    return $header;
}

function bus_authorise(): void
{
    if (BUS_TOKEN === '' || BUS_TOKEN === 'CHANGE_ME_TO_A_LONG_RANDOM_STRING') {
        bus_fail(500, 'Server is not configured: edit BUS_TOKEN at the top of api.php.');
    }
    $given = bus_token();
    if ($given === '') {
        $given = (string) bus_param('token');
    }
    if ($given === '' || !hash_equals(BUS_TOKEN, $given)) {
        bus_fail(401, 'Bad or missing token.');
    }
}

function bus_clean(string $value, int $max): string
{
    $value = str_replace(array("\r\n", "\r"), "\n", $value);
    $value = preg_replace('/[ \t]+/u', ' ', $value);
    if ($value === null) {
        $value = '';
    }
    $value = trim($value);
    if (function_exists('mb_substr')) {
        return mb_substr($value, 0, $max, 'UTF-8');
    }
    return substr($value, 0, $max);
}

/**
 * Names are restricted so they stay safe in URLs, logs and the flat store.
 * `*` is the broadcast recipient and is only allowed where a recipient is
 * expected; it is never a valid sender or mailbox name.
 */
function bus_name(string $raw, string $label, bool $allowBroadcast = false)
{
    $trimmed = trim($raw);
    if ($trimmed === '*') {
        if ($allowBroadcast) {
            return '*';
        }
        bus_fail(400, 'A ' . $label . ' cannot be "*". Use a specific instance name.');
    }
    $name = preg_replace('/[^A-Za-z0-9._-]+/', '-', $trimmed);
    if (!is_string($name) || $name === '') {
        bus_fail(400, 'A valid ' . $label . ' name is required (letters, digits, dot, dash, underscore).');
    }
    if (strlen($name) > 64) {
        bus_fail(400, 'Name is too long.');
    }
    return $name;
}

/* ============================= ACTIONS ============================= */

function bus_action_send(string $file): void
{
    $from = bus_name((string) bus_param('from'), 'sender');
    $to   = bus_name((string) bus_param('to'), 'recipient', true);
    $text = bus_param('text');
    $text = trim(str_replace(array("\r\n", "\r"), "\n", (string) $text));
    if ($text === '') {
        bus_fail(400, 'Message text is empty.');
    }
    if (strlen($text) > BUS_MAX_TEXT) {
        bus_fail(400, 'Message is too long (' . strlen($text) . ' > ' . BUS_MAX_TEXT . ' bytes).');
    }
    $kind = bus_clean((string) bus_param('kind', 'note'), 32);
    $allowed = array('note', 'question', 'answer', 'handoff', 'result', 'ack', 'alert');
    if (!in_array($kind, $allowed, true)) {
        $kind = 'note';
    }
    $thread = bus_clean((string) bus_param('thread'), BUS_MAX_THREAD);
    if ($from === $to && $to !== '*') {
        bus_fail(400, 'Cannot send a message to yourself.');
    }

    $lock = bus_lock($file);
    try {
        $data  = bus_read($file);
        $id    = (int) $data['nextID'];
        $entry = array(
            'id'     => $id,
            'from'   => $from,
            'to'     => $to,
            'kind'   => $kind,
            'text'   => $text,
            'ts'     => time(),
        );
        if ($thread !== '') {
            $entry['thread'] = $thread;
        }
        $data['messages'][] = $entry;
        if (count($data['messages']) > BUS_MAX_MESSAGES) {
            $data['messages'] = array_slice($data['messages'], -BUS_MAX_MESSAGES);
        }
        $data['nextID'] = $id + 1;
        bus_write($file, $data);
    } finally {
        bus_unlock($lock);
    }

    bus_send_json(array(
        'ok'     => true,
        'id'     => $id,
        'from'   => $from,
        'to'     => $to,
        'kind'   => $kind,
        'thread' => $thread,
        'queued' => true,
    ));
}

function bus_action_inbox(string $file): void
{
    $to    = bus_name((string) bus_param('to'), 'recipient');
    $after = (int) bus_param('after', '0');
    $limit = (int) bus_param('limit', '20');
    $limit = max(1, min(100, $limit));

    $data     = bus_read($file);
    $messages = array();
    foreach ($data['messages'] as $m) {
        if ((int) $m['id'] <= $after) {
            continue;
        }
        if ($m['to'] !== $to && $m['to'] !== '*') {
            continue;
        }
        if ($m['from'] === $to) {
            continue;
        }
        $messages[] = $m;
    }

    $total = count($messages);
    if ($total > $limit) {
        $messages = array_slice($messages, -$limit);
    }

    $lastID = 0;
    foreach ($data['messages'] as $m) {
        $lastID = max($lastID, (int) $m['id']);
    }

    bus_send_json(array(
        'ok'       => true,
        'to'       => $to,
        'after'    => $after,
        'count'    => count($messages),
        'pending'  => $total,
        'storeLastID' => $lastID,
        'messages' => $messages,
    ));
}

function bus_action_peers(string $file): void
{
    $to     = bus_name((string) bus_param('to'), 'recipient');
    $after  = (int) bus_param('after', '0');
    $data   = bus_read($file);
    $peers  = array();
    $unread = 0;

    foreach ($data['messages'] as $m) {
        $from = (string) $m['from'];
        if ($from === $to) {
            continue;
        }
        if (!isset($peers[$from])) {
            $peers[$from] = array(
                'name'      => $from,
                'messages'  => 0,
                'lastID'    => 0,
                'lastTS'    => 0,
                'lastText'  => '',
            );
        }
        $peers[$from]['messages']++;
        if ((int) $m['id'] > (int) $peers[$from]['lastID']) {
            $peers[$from]['lastID']   = (int) $m['id'];
            $peers[$from]['lastTS']   = (int) $m['ts'];
            $peers[$from]['lastText'] = substr((string) $m['text'], 0, 160);
        }
        if ($m['to'] === $to && (int) $m['id'] > $after && $m['to'] !== '*') {
            $unread++;
        }
        if ($m['to'] === '*' && (int) $m['id'] > $after) {
            $unread++;
        }
    }

    uasort($peers, function ($a, $b) {
        return $b['lastTS'] <=> $a['lastTS'];
    });

    $lastID = 0;
    foreach ($data['messages'] as $m) {
        $lastID = max($lastID, (int) $m['id']);
    }

    bus_send_json(array(
        'ok'      => true,
        'me'      => $to,
        'unread'  => $unread,
        'total'   => count($data['messages']),
        'storeLastID' => $lastID,
        'peers'   => array_values($peers),
    ));
}

/**
 * Every message on the bus, in arrival order, regardless of recipient.
 * This is what the web viewer polls with an `after` cursor. It exposes the
 * whole conversation to anyone holding the token, so it is never served
 * without one.
 */
function bus_action_feed(string $file): void
{
    $after = (int) bus_param('after', '0');
    $limit = (int) bus_param('limit', '500');
    $limit = max(1, min(2000, $limit));

    $data    = bus_read($file);
    $lastID  = 0;
    $newest  = 0;
    $fresh   = array();
    foreach ($data['messages'] as $m) {
        $id = (int) $m['id'];
        $lastID = max($lastID, $id);
        $newest = max($newest, (int) $m['ts']);
        if ($id > $after) {
            $fresh[] = $m;
        }
    }

    // On the first load, hand back only the tail so the viewer starts populated
    // instead of rendering thousands of pruned messages.
    $truncated = false;
    if (count($fresh) > $limit) {
        $fresh     = array_slice($fresh, -$limit);
        $truncated = true;
    }

    bus_send_json(array(
        'ok'          => true,
        'count'       => count($fresh),
        'truncated'   => $truncated,
        'total'       => count($data['messages']),
        'storeLastID' => $lastID,
        'newestTS'    => $newest,
        'maxMessages' => BUS_MAX_MESSAGES,
        'messages'    => $fresh,
    ));
}

function bus_action_health(string $file): void
{
    $data     = bus_read($file);
    $docroot  = bus_docroot();
    $lastID   = 0;
    $newest   = 0;
    foreach ($data['messages'] as $m) {
        $lastID = max($lastID, (int) $m['id']);
        $newest = max($newest, (int) $m['ts']);
    }
    bus_send_json(array(
        'ok'          => true,
        'service'     => 'llm-talk',
        'version'     => 1,
        'php'         => PHP_VERSION,
        'configured'  => BUS_TOKEN !== '' && BUS_TOKEN !== 'CHANGE_ME_TO_A_LONG_RANDOM_STRING',
        'store'       => $file,
        'storeSize'   => is_file($file) ? filesize($file) : 0,
        'writable'    => is_writable(dirname($file)),
        'webRoot'     => $docroot,
        'storePublic' => $docroot !== '' && strpos((string) realpath(dirname($file)), (string) realpath($docroot)) === 0,
        'messages'    => count($data['messages']),
        'storeLastID' => $lastID,
        'newestTS'    => $newest,
        'maxMessages' => BUS_MAX_MESSAGES,
    ));
}

/* ============================== ROUTER ============================== */

$file    = bus_data_file();
$action  = (string) bus_param('action', '');

if ($action === 'health') {
    bus_action_health($file);
}

bus_authorise();

switch ($action) {
    case 'send':
        bus_action_send($file);
        // no break
    case 'inbox':
        bus_action_inbox($file);
        // no break
    case 'peers':
        bus_action_peers($file);
        // no break
    case 'feed':
        bus_action_feed($file);
        // no break
    default:
        bus_fail(400, 'Unknown action. Use action=send, inbox, peers, feed, or health.');
}
