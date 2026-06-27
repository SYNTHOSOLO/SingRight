import Image from "next/image";

type LogoProps = {
  className?: string;
  priority?: boolean;
};

export function Logo({ className = "h-14 w-14 rounded-2xl", priority = false }: LogoProps) {
  return (
    <div
      className={`relative shrink-0 overflow-hidden bg-white shadow-lg shadow-violet-600/20 ${className}`}
    >
      <Image
        src="/logo.jpg"
        alt="AI Vocal Coach"
        fill
        sizes="(max-width: 768px) 56px, 56px"
        className="object-contain p-1.5"
        priority={priority}
      />
    </div>
  );
}
