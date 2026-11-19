export default function BrandLogo({ compact = false, light = false, className = '' }) {
  return <div className={`flex items-center gap-3 ${className}`}>
    <img src="/geeta-university-logo.webp" alt="Geeta University official logo" className={compact ? 'h-10 w-10 rounded-lg bg-white object-contain p-1' : 'h-16 w-auto max-w-full object-contain'} />
    {!compact && <div className="text-xl font-extrabold leading-tight"><span className={light ? 'text-[#4DA3E6]' : 'text-[#012E55]'}>GU</span><span className="text-[#E16B1F]"> Drishti</span></div>}
  </div>;
}
