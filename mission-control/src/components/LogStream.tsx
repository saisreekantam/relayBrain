'use client';

import React, { useEffect, useRef, useState } from 'react';
import styles from './LogStream.module.css';

const initialLogs = [
  { time: '14:03:22', type: 'agent', agent: 'CEO', msg: 'Objective dispatched → Architect', raw: false },
  { time: '14:03:24', type: 'agent', agent: 'Architect', msg: 'Analyzing system requirements...', raw: false },
  { time: '14:03:31', type: 'agent', agent: 'Architect', msg: 'Decision: microservice arch (confidence 91%)', raw: false },
  { time: '14:03:33', type: 'handoff', msg: '→ Backend Task received: generate REST API scaffold', raw: false },
  { time: '14:03:44', type: 'agent', agent: 'Backend', msg: 'Generated 12 endpoints', raw: false },
  { time: '14:03:45', type: 'handoff', msg: '→ QA Task received: test coverage', raw: false },
  { time: '14:03:52', type: 'success', msg: '✓ QA 47/47 tests passed', raw: false },
  { time: '14:03:53', type: 'handoff', msg: '→ Security Task received: CVE scan', raw: false },
];

export default function LogStream() {
  const [logs, setLogs] = useState(initialLogs);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  // Simulate incoming logs
  useEffect(() => {
    const sequence = [
      { delay: 2000, log: { time: '14:04:01', type: 'warning', msg: '⚠ Security Found: outdated OpenSSL (CVE-2024-0553)', raw: false } },
      { delay: 4000, log: { time: '14:04:02', type: 'agent', agent: 'Security', msg: 'Auto-patching...', raw: false } },
      { delay: 7000, log: { time: '14:04:08', type: 'success', msg: '✓ Security Patch applied, re-scanning', raw: false } },
      { delay: 9000, log: { time: '14:04:11', type: 'success', msg: '✓ Security Clean. Clearance granted.', raw: false } },
      { delay: 10000, log: { time: '14:04:12', type: 'handoff', msg: '→ Deployment Task received: canary deploy', raw: false } },
    ];

    const timeouts = sequence.map(s => setTimeout(() => {
      setLogs(prev => [...prev, s.log]);
    }, s.delay));

    return () => timeouts.forEach(clearTimeout);
  }, []);

  return (
    <div className={`glass-panel ${styles.panel}`}>
      <div className={styles.header}>
        <div className="section-title" style={{ marginBottom: 0 }}>LOG STREAM</div>
        <div className={styles.controls}>
          <span className={styles.filterActive}>ALL</span>
          <span>DECISIONS</span>
          <span>ERRORS</span>
        </div>
      </div>

      <div className={`${styles.streamContainer} mono custom-scrollbar`}>
        {logs.map((log, i) => (
          <div key={i} className={`${styles.logLine} ${styles[log.type]}`}>
            <span className={styles.timestamp}>[{log.time}]</span>
            {log.type === 'agent' && <span className={styles.agentBadge}>● {log.agent}</span>}
            <span className={styles.message}>{log.msg}</span>
          </div>
        ))}
        <div ref={endRef} />
      </div>
    </div>
  );
}
