// Transient success / error messages, announced to screen readers.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

type Kind = "success" | "error";
interface Message {
  id: number;
  kind: Kind;
  text: string;
}

const FeedbackContext = createContext<(kind: Kind, text: string) => void>(() => {});

export const useNotify = () => useContext(FeedbackContext);

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const next = useRef(1);

  const dismiss = useCallback((id: number) => setMessages((m) => m.filter((x) => x.id !== id)), []);
  const notify = useCallback((kind: Kind, text: string) => {
    const id = next.current++;
    setMessages((m) => [...m.slice(-2), { id, kind, text }]);
  }, []);

  return (
    <FeedbackContext.Provider value={notify}>
      {children}
      <div className="toasts">
        {/* Separate live regions so errors interrupt and successes do not. */}
        <div role="status" aria-live="polite">
          {messages.filter((m) => m.kind === "success").map((m) => (
            <Toast key={m.id} message={m} onClose={dismiss} />
          ))}
        </div>
        <div role="alert" aria-live="assertive">
          {messages.filter((m) => m.kind === "error").map((m) => (
            <Toast key={m.id} message={m} onClose={dismiss} />
          ))}
        </div>
      </div>
    </FeedbackContext.Provider>
  );
}

function Toast({ message, onClose }: { message: Message; onClose: (id: number) => void }) {
  useEffect(() => {
    if (message.kind === "error") return; // errors stay until dismissed
    const t = setTimeout(() => onClose(message.id), 6000);
    return () => clearTimeout(t);
  }, [message, onClose]);
  return (
    <div className={`toast ${message.kind}`}>
      <span>{message.text}</span>
      <button className="toast-close" aria-label="Dismiss message" onClick={() => onClose(message.id)}>
        ×
      </button>
    </div>
  );
}
