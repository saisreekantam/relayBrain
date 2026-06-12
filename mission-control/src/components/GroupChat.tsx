'use client';

import React, { useState, useEffect, useRef } from 'react';
import styles from './GroupChat.module.css';
import ReasoningSummary from './ReasoningSummary';

const initialMessages = [
  {
    id: 1,
    sender: 'User',
    role: 'operator',
    text: '@Architect we need to add a new Redis cache layer for the API to improve latency.',
    time: '10:02 AM',
  },
  {
    id: 2,
    sender: 'Architect Agent',
    role: 'architect',
    text: 'Analyzing the architecture for caching layer insertion...',
    time: '10:03 AM',
    reasoning: {
      goal: 'Integrate Redis cache for API latency',
      constraints: 'Existing data flow, minimal downtime',
      decision: 'Deploy Redis as a sidecar to the API service',
      tradeoff: 'Higher memory overhead per node, but faster local access',
      nextAction: 'Hand off to Developer Agent to implement connection'
    }
  },
  {
    id: 3,
    sender: 'Developer Agent',
    role: 'developer',
    text: 'I have generated the Redis connection utilities and updated the API handlers. Preparing PR.',
    time: '10:05 AM',
  }
];

export default function GroupChat() {
  const [messages, setMessages] = useState(initialMessages);
  const [input, setInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;

    const userMessage = {
      id: Date.now(),
      sender: 'User',
      role: 'operator',
      text: input,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };

    setMessages(prev => [...prev, userMessage]);
    setInput('');

    // Simulate agent response
    setTimeout(() => {
      const agentMessage = {
        id: Date.now() + 1,
        sender: 'Security Agent',
        role: 'security',
        text: 'Reviewing the requested changes for security implications...',
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        reasoning: {
          goal: 'Security scan on new Redis implementation',
          constraints: 'Prevent unauthenticated access',
          decision: 'Enforce requirepass configuration in Redis and block external ports',
          tradeoff: 'Slight configuration complexity',
          nextAction: 'Proceed with safe deployment'
        }
      };
      setMessages(prev => [...prev, agentMessage]);
    }, 2000);
  };

  return (
    <div className={styles.chatContainer}>
      <div className={styles.header}>
        <div className={styles.channelInfo}>
          <h2 className={styles.channelName}># orbit-os-general</h2>
          <span className={styles.channelTopic}>Main channel for coordinating the Orbit OS DevSecOps platform</span>
        </div>
        <div className={styles.agentAvatars}>
          <div className={`${styles.avatarMini} ${styles.architect}`}>A</div>
          <div className={`${styles.avatarMini} ${styles.developer}`}>B</div>
          <div className={`${styles.avatarMini} ${styles.security}`}>S</div>
          <div className={`${styles.avatarMini} ${styles.deployment}`}>D</div>
        </div>
      </div>

      <div className={styles.messagesArea}>
        {messages.map((msg) => (
          <div key={msg.id} className={`${styles.messageWrapper} ${msg.sender === 'User' ? styles.isUser : ''}`}>
            <div className={`${styles.avatar} ${styles[msg.role]}`}>
              {msg.role === 'operator' ? 'JD' : msg.role === 'architect' ? 'A' : msg.role === 'developer' ? 'B' : msg.role === 'security' ? 'S' : 'D'}
            </div>
            <div className={styles.messageContent}>
              <div className={styles.messageHeader}>
                <span className={styles.senderName}>{msg.sender}</span>
                <span className={styles.timestamp}>{msg.time}</span>
              </div>
              <div className={styles.messageText}>{msg.text}</div>
              {msg.reasoning && (
                <div className={styles.reasoningWrapper}>
                  <ReasoningSummary activeAgentName={msg.sender} data={msg.reasoning} />
                </div>
              )}
            </div>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      <div className={styles.inputArea}>
        <form onSubmit={handleSend} className={styles.inputForm}>
          <button type="button" className={styles.attachBtn}>+</button>
          <input 
            type="text" 
            className={styles.textInput} 
            placeholder="Message #orbit-os-general and @agents..." 
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
          <button type="submit" className={styles.sendBtn}>Send</button>
        </form>
      </div>
    </div>
  );
}
