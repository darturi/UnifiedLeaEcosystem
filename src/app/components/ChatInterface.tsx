import { useState } from 'react';
import { Send, Pause, Play, BarChart3 } from 'lucide-react';
import { ChatMessage } from '../api';

export function ChatInterface({
  error,
  isPaused,
  isRunning,
  messages,
  statusLog,
  onSubmit,
  onTogglePause,
  theoremName,
  currentStepIndex,
}: {
  error?: string;
  isPaused: boolean;
  isRunning: boolean;
  messages: ChatMessage[];
  statusLog: { id: string; message: string; created_at: string }[];
  onSubmit: (content: string) => Promise<boolean>;
  onTogglePause: () => void;
  theoremName: string;
  currentStepIndex: number;
}) {
  const [input, setInput] = useState('');
  const [showStats, setShowStats] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const content = input.trim();
    if (!content || isRunning || isSubmitting) {
      return;
    }
    setIsSubmitting(true);
    const succeeded = await onSubmit(content);
    if (succeeded) {
      setInput('');
    }
    setIsSubmitting(false);
  };

  return (
    <div className="flex flex-col h-full bg-background">
      <div className="p-4 border-b border-border flex items-center justify-between gap-3">
        <h2 className="text-foreground truncate">{theoremName}</h2>
        <div className="flex items-center gap-2">
          <button
            onClick={onTogglePause}
            className="px-3 py-2 rounded-md bg-secondary text-secondary-foreground hover:opacity-90 transition-opacity flex items-center gap-2"
          >
            {isPaused ? (
              <>
                <Play className="w-4 h-4" />
                Resume
              </>
            ) : (
              <>
                <Pause className="w-4 h-4" />
                Pause
              </>
            )}
          </button>
          <button
            onClick={() => setShowStats(!showStats)}
            className="px-3 py-2 rounded-md bg-secondary text-secondary-foreground hover:opacity-90 transition-opacity flex items-center gap-2"
          >
            <BarChart3 className="w-4 h-4" />
            Statistics
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.length === 0 && (
          <div className="h-full flex items-center justify-center text-center text-muted-foreground">
            Enter a theorem or natural-language proof task to start Lea.
          </div>
        )}

        {messages.map((message) => {
          const isUser = message.role === 'user';
          const isSystem = message.role === 'system';

          return (
            <div
              key={message.id}
              className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`max-w-[80%] rounded-lg p-4 transition-all ${
                  isUser
                    ? 'bg-primary text-primary-foreground'
                    : isSystem
                    ? 'bg-accent text-accent-foreground'
                    : 'bg-muted text-muted-foreground'
                }`}
              >
                <p className="whitespace-pre-wrap">{message.content}</p>
                <p className="text-xs opacity-70 mt-2">
                  {new Date(message.created_at).toLocaleTimeString()}
                </p>
              </div>
            </div>
          );
        })}

        {isRunning && (
          <div className="rounded-md bg-accent p-3 text-sm text-accent-foreground">
            Lea is working{currentStepIndex >= 0 ? `, showing step ${currentStepIndex + 1}` : ''}.
            {statusLog.length > 0 && (
              <div className="mt-2 space-y-1">
                {statusLog.map((item) => (
                  <div key={item.id} className="text-xs text-muted-foreground">
                    {new Date(item.created_at).toLocaleTimeString()} - {item.message}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {isSubmitting && !isRunning && (
          <div className="text-sm text-muted-foreground">
            Submitting to Lea...
          </div>
        )}

        {showStats && (
          <div className="rounded-md bg-accent p-3 text-sm text-accent-foreground">
            Statistics are decorative in this version.
          </div>
        )}

        {error && (
          <div className="rounded-md border border-destructive bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        )}
      </div>

      <div className="p-4 border-t border-border">
        <form onSubmit={handleSubmit} className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Enter your theorem in LaTeX or natural language..."
            className="flex-1 px-4 py-2 rounded-md bg-input-background border border-border focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <button
            type="submit"
            disabled={isRunning || isSubmitting}
            className="px-4 py-2 bg-primary text-primary-foreground rounded-md hover:opacity-90 transition-opacity flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Send className="w-4 h-4" />
            {isSubmitting ? 'Sending' : 'Send'}
          </button>
        </form>
      </div>
    </div>
  );
}
