'use client'

import { useMemo, useState } from 'react'
import { Check, ChevronsUpDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

export interface SearchableInventoryItem {
  id: string
  name: string
  category: string
  price: number
  quantity: number
}

interface InventorySearchSelectProps {
  items: SearchableInventoryItem[]
  value: string
  onValueChange: (value: string) => void
  placeholder?: string
}

export default function InventorySearchSelect({
  items,
  value,
  onValueChange,
  placeholder = 'Search item...',
}: InventorySearchSelectProps) {
  const [open, setOpen] = useState(false)

  const selectedItem = useMemo(
    () => items.find((item) => item.id === value) ?? null,
    [items, value]
  )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-full justify-between"
        >
          {selectedItem ? `${selectedItem.name} (${selectedItem.category})` : placeholder}
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[420px] p-0" align="start">
        <Command>
          <CommandInput placeholder="Type item name..." />
          <CommandList>
            <CommandEmpty>No matching items found.</CommandEmpty>
            <CommandGroup>
              {items.map((item) => (
                <CommandItem
                  key={item.id}
                  value={`${item.name} ${item.category}`}
                  onSelect={() => {
                    onValueChange(item.id)
                    setOpen(false)
                  }}
                >
                  <Check
                    className={cn(
                      'mr-2 h-4 w-4',
                      value === item.id ? 'opacity-100' : 'opacity-0'
                    )}
                  />
                  <div className="flex w-full items-center justify-between gap-3">
                    <span>{item.name}</span>
                    <span className="text-xs text-slate-500">{item.category}</span>
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
