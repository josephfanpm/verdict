import { KeyRound } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { setTokenHandler } from '../api';
import { Button } from './ui/button';
import { Dialog, DialogContent } from './ui/dialog';
import { Input } from './ui/input';

/** Asks for the admin token when the API answers 401, instead of a browser prompt. */
export function TokenDialog() {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const resolver = useRef<((token: string | null) => void) | null>(null);

  useEffect(() => {
    setTokenHandler(
      () =>
        new Promise((resolve) => {
          resolver.current = resolve;
          setValue('');
          setOpen(true);
        })
    );
  }, []);

  const finish = (token: string | null) => {
    resolver.current?.(token);
    resolver.current = null;
    setOpen(false);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    finish(value.trim() || null);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && finish(null)}>
      <DialogContent title="Admin token required" description="This server needs a token to change flags." className="max-w-sm">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="relative">
            <KeyRound className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-faint" />
            <Input autoFocus type="password" value={value} onChange={(e) => setValue(e.target.value)} className="pl-9" aria-label="Admin token" />
          </div>
          <Button variant="primary" disabled={!value.trim()}>
            Continue
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
