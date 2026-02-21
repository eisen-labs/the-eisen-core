import Image from 'next/image';
export default function Home() {
  return (
    <div className="flex min-h-screen flex-col">
      <main className="flex flex-1 items-center justify-center p-4">
        <div className="text-center select-none">
          <div className="flex items-baseline justify-center gap-2">
            <h1 className="font-serif text-4xl">Constellation</h1>
            <Image src="/logo.svg" alt="Constellation Logo" width={24} height={24} />
          </div>
        </div>
      </main>

      <footer>
        <div className="text-foreground/50 p-8 text-center text-sm">
          &copy; {new Date().getFullYear()} Constellation. All rights reserved.
        </div>
      </footer>
    </div>
  );
}
